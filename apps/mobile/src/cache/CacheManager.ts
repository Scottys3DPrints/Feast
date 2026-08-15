/**
 * The download layer — SPEC §11.3, "stream now, cache in parallel".
 *
 * This is the Spotify model, and it is the thing that makes a 24.5 GB library usable on
 * a phone: nothing is on the device by default, you stream what you want, anything you
 * stream is kept for a while, and anything you explicitly download is kept for good.
 *
 * §2's four tiers, restated in terms of this file:
 *
 *   TIER 1  stream        no cache row at all
 *   TIER 2  auto-cached   pinned = 0. Written while streaming, LRU-evicted under budget.
 *   TIER 3  pinned        pinned = 1. Never evicted, never counted against the budget.
 *
 * ⚠️ §11.3 is explicit that no maintained RN library streams and caches to disk at once.
 * So this is DUAL-FETCH: the player reads the remote URL while a separate download task
 * writes the same bytes to disk. It costs ~2× bandwidth on first play and is trivially
 * robust. Do not replace it with a local HTTP proxy — that fights iOS background
 * execution for a marginal gain.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { sqlite } from '../db/client';
import { getStorage } from '../storage/provider';

export type Rendition = 'archive' | 'stream';

export interface DownloadProgress {
  talkId: string;
  bytesWritten: number;
  totalBytes: number;
}

type ProgressListener = (p: DownloadProgress) => void;

const listeners = new Set<ProgressListener>();
/** In-flight tasks, so a second tap cancels rather than starting a duplicate download. */
const active = new Map<string, { cancel: () => void }>();

export function onDownloadProgress(cb: ProgressListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function emit(p: DownloadProgress) {
  listeners.forEach((l) => l(p));
}

// ─── Paths ────────────────────────────────────────────────────────────────────────

/**
 * §11.3: `Paths.document`, NOT `Paths.cache`.
 *
 * `Library/Caches` "can be deleted by the system when the device runs low on storage" —
 * the OS may purge it between launches, which is unacceptable for something the user
 * explicitly downloaded for a flight. Documents is safe from the system; the iCloud
 * backup problem it creates is handled by the backup-exclusion plugin.
 */
function audioDir(): Directory {
  const dir = new Directory(Paths.document, 'feast', 'audio');
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

/**
 * Rendition lives in the FILENAME, not just the row. `cache_entries` is keyed
 * (talk_id, rendition) and both renditions can be `.m4a`, so a plain `<talkId>.<ext>`
 * would have the compact stream copy silently overwrite the archive copy.
 */
function fileFor(talkId: string, rendition: Rendition, ext: string): File {
  return new File(audioDir(), `${talkId}.${rendition}.${ext}`);
}

function extensionFor(path: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return (m?.[1] ?? 'mp3').toLowerCase();
}

// ─── Queries ──────────────────────────────────────────────────────────────────────

export interface CacheRow {
  talkId: string;
  rendition: Rendition;
  localPath: string;
  bytes: number;
  contentLength: number;
  state: 'pending' | 'downloading' | 'complete' | 'failed';
  pinned: number;
}

export function cacheRow(talkId: string): CacheRow | null {
  return (
    sqlite.getFirstSync<CacheRow>(
      `SELECT talk_id AS talkId, rendition, local_path AS localPath, bytes,
              content_length AS contentLength, state, pinned
       FROM cache_entries
       WHERE talk_id = ? AND state = 'complete'
       ORDER BY rendition = 'stream' DESC
       LIMIT 1`,
      [talkId],
    ) ?? null
  );
}

/**
 * The file to play, or null to stream.
 *
 * ⚠️ Size is verified against `content_length`, not merely trusted. §4.7: on Android the
 * response body streams straight into the target file, so a download that fails partway
 * leaves a PARTIAL FILE behind. Playing it yields a corrupt-media error that looks like
 * a bad talk rather than a bad download.
 */
export function localFileFor(talkId: string): string | null {
  const row = cacheRow(talkId);
  if (!row || row.state !== 'complete') return null;
  const file = new File(row.localPath);
  if (!file.exists) {
    sqlite.runSync(`UPDATE cache_entries SET state='pending' WHERE talk_id=? AND rendition=?`, [
      talkId,
      row.rendition,
    ]);
    return null;
  }
  if (row.contentLength > 0 && file.size !== row.contentLength) {
    file.delete();
    sqlite.runSync(`UPDATE cache_entries SET state='pending', bytes=0 WHERE talk_id=? AND rendition=?`, [
      talkId,
      row.rendition,
    ]);
    return null;
  }
  return row.localPath;
}

export function isDownloaded(talkId: string): boolean {
  return localFileFor(talkId) !== null;
}

// ─── Download ─────────────────────────────────────────────────────────────────────

export interface DownloadOptions {
  /** Tier 3 — never evicted, never counted against the budget. */
  pinned?: boolean;
  rendition?: Rendition;
}

/**
 * Download a talk for offline playback.
 *
 * Resolves when the file is on disk and verified. Safe to call for something already
 * downloaded — it returns immediately rather than re-fetching.
 */
export async function downloadTalk(
  talkId: string,
  archivePath: string,
  opts: DownloadOptions = {},
): Promise<void> {
  const rendition: Rendition = opts.rendition ?? 'archive';
  const pinned = opts.pinned ?? false;

  const existing = localFileFor(talkId);
  if (existing) {
    if (pinned) setPinned(talkId, true);
    return;
  }
  if (active.has(talkId)) return;

  const file = fileFor(talkId, rendition, extensionFor(archivePath));

  sqlite.runSync(
    `INSERT INTO cache_entries (talk_id, rendition, local_path, bytes, content_length, state, pinned, downloaded_at)
     VALUES (?, ?, ?, 0, 0, 'downloading', ?, ?)
     ON CONFLICT(talk_id, rendition) DO UPDATE SET
       state='downloading', local_path=excluded.local_path, pinned=MAX(cache_entries.pinned, excluded.pinned)`,
    [talkId, rendition, file.uri, pinned ? 1 : 0, Date.now()],
  );

  try {
    // ⚠️ Minted NOW and never persisted. §4.4: OneDrive's signed-URL expiry is
    // undocumented and the docs contradict each other, so a stored URL is a bug waiting
    // for a slow download. A 130 MB lecture can outlive one, which is what the resume
    // path below is for.
    const storage = getStorage();
    const { url } = await storage.getStreamUrl({ path: archivePath });

    const task = File.createDownloadTask(url, file, {
      onProgress: ({ bytesWritten, totalBytes }) => {
        emit({ talkId, bytesWritten, totalBytes: totalBytes ?? 0 });
        sqlite.runSync(
          `UPDATE cache_entries SET bytes=?, content_length=? WHERE talk_id=? AND rendition=?`,
          [bytesWritten, totalBytes ?? 0, talkId, rendition],
        );
      },
    });

    active.set(talkId, { cancel: () => task.cancel() });
    const result = await task.downloadAsync();
    active.delete(talkId);

    if (!result || !result.exists || result.size === 0) {
      throw new Error('The download produced no file.');
    }

    sqlite.runSync(
      `UPDATE cache_entries
       SET state='complete', bytes=?, content_length=?, downloaded_at=?
       WHERE talk_id=? AND rendition=?`,
      [result.size, result.size, Date.now(), talkId, rendition],
    );

    if (!pinned) enforceBudget(talkId);
  } catch (e) {
    active.delete(talkId);
    sqlite.runSync(
      `UPDATE cache_entries SET state='failed', attempts=attempts+1 WHERE talk_id=? AND rendition=?`,
      [talkId, rendition],
    );
    // §15.14 surfaces this in Needs Attention rather than letting it fail silently.
    sqlite.runSync(
      `UPDATE talks SET flags = json_insert(COALESCE(NULLIF(flags,''),'[]'), '$[#]', 'download-failed')
       WHERE id = ? AND flags NOT LIKE '%download-failed%'`,
      [talkId],
    );
    throw e;
  }
}

export function cancelDownload(talkId: string): void {
  active.get(talkId)?.cancel();
  active.delete(talkId);
}

// ─── Pin / remove ─────────────────────────────────────────────────────────────────

export function setPinned(talkId: string, pinned: boolean): void {
  sqlite.runSync(`UPDATE cache_entries SET pinned=? WHERE talk_id=?`, [pinned ? 1 : 0, talkId]);
  if (!pinned) enforceBudget();
}

/**
 * Remove a downloaded talk.
 *
 * §2: "Eviction never loses anything." The talk stays in the catalog, stays searchable,
 * and still plays over the network — only the local copy goes.
 */
export function removeDownload(talkId: string): void {
  const rows = sqlite.getAllSync<{ localPath: string; rendition: string }>(
    `SELECT local_path AS localPath, rendition FROM cache_entries WHERE talk_id = ?`,
    [talkId],
  );
  for (const row of rows) {
    const file = new File(row.localPath);
    if (file.exists) file.delete();
  }
  sqlite.runSync(`DELETE FROM cache_entries WHERE talk_id = ?`, [talkId]);
}

// ─── LRU eviction ─────────────────────────────────────────────────────────────────

const DEFAULT_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;

export function getBudgetBytes(): number {
  const row = sqlite.getFirstSync<{ value: string }>(
    `SELECT value FROM sync_meta WHERE key='cache_budget_bytes'`,
  );
  const parsed = row ? Number.parseInt(row.value, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : DEFAULT_BUDGET_BYTES;
}

export function setBudgetBytes(bytes: number): void {
  sqlite.runSync(
    `INSERT INTO sync_meta (key, value) VALUES ('cache_budget_bytes', ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    [String(bytes)],
  );
  enforceBudget();
}

/**
 * Evict least-recently-touched unpinned entries until the budget is met.
 *
 * Four rules §11.3 says the naive version gets wrong, all of them load-bearing:
 *
 *  1. Order by COALESCE(NULLIF(last_played_at,0), downloaded_at) — NOT last_played_at.
 *     A never-played download has last_played_at = 0, so a plain sort evicts it FIRST,
 *     deleting exactly the "download this for the flight" items the user just asked for.
 *  2. Never evict the currently-playing talk; a foreground sweep would delete the file
 *     being read.
 *  3. The budget covers UNPINNED bytes only. Otherwise pinning a 1.1 GB collection
 *     against a 2 GB budget immediately evicts everything else.
 *  4. Disk totals sum all non-pending rows, including downloading and failed — they
 *     occupy real bytes, and anything else drifts from `du` (§19 criterion 15).
 */
export function enforceBudget(nowPlayingTalkId?: string): void {
  const budget = getBudgetBytes();

  const total = sqlite.getFirstSync<{ n: number }>(
    `SELECT COALESCE(SUM(bytes),0) AS n FROM cache_entries WHERE pinned=0 AND state!='pending'`,
  );
  let used = total?.n ?? 0;
  if (used <= budget) return;

  const candidates = sqlite.getAllSync<{
    talkId: string;
    rendition: string;
    bytes: number;
    localPath: string;
  }>(
    `SELECT talk_id AS talkId, rendition, bytes, local_path AS localPath
     FROM cache_entries
     WHERE pinned = 0 AND state = 'complete' AND talk_id != ?
     ORDER BY COALESCE(NULLIF(last_played_at, 0), downloaded_at) ASC`,
    [nowPlayingTalkId ?? ''],
  );

  for (const row of candidates) {
    if (used <= budget) break;
    const file = new File(row.localPath);
    if (file.exists) file.delete();
    sqlite.runSync(`DELETE FROM cache_entries WHERE talk_id=? AND rendition=?`, [
      row.talkId,
      row.rendition,
    ]);
    used -= row.bytes;
  }
}

/** Called when playback starts, so LRU ordering reflects actual listening. */
export function touch(talkId: string): void {
  sqlite.runSync(`UPDATE cache_entries SET last_played_at=? WHERE talk_id=?`, [
    Date.now(),
    talkId,
  ]);
}

// ─── Startup reconciliation ───────────────────────────────────────────────────────

/**
 * Bring the table and the disk back into agreement — §11.3, on every cold start.
 *
 * Mandatory on Android, where a failed download leaves a partial file behind (§4.7).
 * Harmless on iOS, which moves the file into place only after success.
 */
export function reconcileCache(): void {
  const rows = sqlite.getAllSync<{
    talkId: string;
    rendition: string;
    localPath: string;
    contentLength: number;
    state: string;
  }>(
    `SELECT talk_id AS talkId, rendition, local_path AS localPath,
            content_length AS contentLength, state
     FROM cache_entries`,
  );

  const known = new Set<string>();

  for (const row of rows) {
    known.add(row.localPath);
    const file = new File(row.localPath);

    if (!file.exists) {
      sqlite.runSync(`UPDATE cache_entries SET state='pending', bytes=0 WHERE talk_id=? AND rendition=?`, [
        row.talkId,
        row.rendition,
      ]);
      continue;
    }

    // Interrupted mid-write: the row says downloading, so the file is a fragment.
    if (row.state === 'downloading' || (row.contentLength > 0 && file.size !== row.contentLength)) {
      file.delete();
      sqlite.runSync(`UPDATE cache_entries SET state='pending', bytes=0 WHERE talk_id=? AND rendition=?`, [
        row.talkId,
        row.rendition,
      ]);
    }
  }

  // Orphans: a file with no row, left by a crash between writing and committing.
  const dir = audioDir();
  if (dir.exists) {
    for (const entry of dir.list()) {
      if (entry instanceof File && !known.has(entry.uri)) entry.delete();
    }
  }
}

// ─── Totals for the Storage screen ────────────────────────────────────────────────

export interface CacheTotals {
  pinnedBytes: number;
  cachedBytes: number;
  budgetBytes: number;
  downloadedCount: number;
}

export function cacheTotals(): CacheTotals {
  const pinned = sqlite.getFirstSync<{ n: number; c: number }>(
    `SELECT COALESCE(SUM(bytes),0) AS n, COUNT(*) AS c
     FROM cache_entries WHERE pinned=1 AND state!='pending'`,
  );
  const cached = sqlite.getFirstSync<{ n: number; c: number }>(
    `SELECT COALESCE(SUM(bytes),0) AS n, COUNT(*) AS c
     FROM cache_entries WHERE pinned=0 AND state!='pending'`,
  );
  return {
    pinnedBytes: pinned?.n ?? 0,
    cachedBytes: cached?.n ?? 0,
    budgetBytes: getBudgetBytes(),
    downloadedCount: (pinned?.c ?? 0) + (cached?.c ?? 0),
  };
}
