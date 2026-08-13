import { sqlite } from './client';
import type { Residency } from '../ui/ResidencyBadge';

/**
 * Read queries — SPEC §17.
 *
 * "Query only what's on screen … never load 2,000 rows into JS." Every list query
 * here is keyset-paginated or LIMITed, and every one joins the residency state in SQL
 * rather than making the row component ask per-item — 2,000 rows × 1 lookup each is
 * how a 60 fps list becomes a 20 fps one.
 *
 * Written with the raw `expo-sqlite` API rather than Drizzle's builder in the places
 * where the query needs a `COALESCE`/`LEFT JOIN` shape Drizzle expresses awkwardly.
 * Drizzle's typed builder is still the right tool for writes and simple reads.
 */

export interface TalkListItem {
  id: string;
  title: string;
  speakerId: string | null;
  speakerName: string;
  durationSec: number | null;
  sizeBytes: number;
  eventName: string | null;
  sessionName: string | null;
  seriesId: string | null;
  partNumber: number | null;
  artworkPath: string | null;
  artworkColor: string | null;
  archivePath: string;
  streamPath: string | null;
  positionSec: number;
  played: boolean;
  rating: number | null;
  residency: Residency;
}

/**
 * The residency projection, in SQL. `flags` is a JSON array, so the attention check is
 * a LIKE against the serialized text — cheap, and correct for the fixed flag vocabulary
 * of §6.1 (no flag is a substring of another).
 */
const RESIDENCY_SQL = `
  CASE
    WHEN t.flags LIKE '%needs-redownload%'
      OR t.flags LIKE '%download-failed%'
      OR t.flags LIKE '%unplayable-format%'
      OR c.state = 'failed'                      THEN 'attention'
    WHEN c.pinned = 1                            THEN 'pinned'
    WHEN c.state IN ('pending','downloading')    THEN 'downloading'
    WHEN c.state = 'complete'                    THEN 'cached'
    ELSE 'cloud'
  END AS residency`;

const TALK_SELECT = `
  SELECT t.id, t.title, t.speaker_id AS speakerId, t.speaker_name AS speakerName,
         t.duration_sec AS durationSec, t.size_bytes AS sizeBytes,
         t.event_name AS eventName, t.session_name AS sessionName,
         t.series_id AS seriesId, t.part_number AS partNumber,
         t.artwork_path AS artworkPath, t.artwork_color AS artworkColor,
         t.archive_path AS archivePath, t.stream_path AS streamPath,
         COALESCE(ls.position_sec, 0) AS positionSec,
         COALESCE(ls.played, 0) AS played,
         ls.rating AS rating,
         ${RESIDENCY_SQL}
  FROM talks t
  LEFT JOIN listen_state ls ON ls.talk_id = t.id
  -- Prefer the compact stream rendition's cache row when both exist (§11.2).
  LEFT JOIN cache_entries c
    ON c.talk_id = t.id
   AND c.rendition = (
     SELECT rendition FROM cache_entries x
     WHERE x.talk_id = t.id
     ORDER BY CASE x.rendition WHEN 'stream' THEN 0 ELSE 1 END LIMIT 1
   )`;

interface RawTalkRow {
  id: string;
  title: string;
  speakerId: string | null;
  speakerName: string;
  durationSec: number | null;
  sizeBytes: number;
  eventName: string | null;
  sessionName: string | null;
  seriesId: string | null;
  partNumber: number | null;
  artworkPath: string | null;
  artworkColor: string | null;
  archivePath: string;
  streamPath: string | null;
  positionSec: number;
  played: number;
  rating: number | null;
  residency: string;
}

function toItem(r: RawTalkRow): TalkListItem {
  return {
    ...r,
    played: r.played === 1,
    residency: r.residency as Residency,
  };
}

export function countTalks(): number {
  const row = sqlite.getFirstSync<{ n: number }>(
    'SELECT COUNT(*) AS n FROM talks WHERE missing_since IS NULL',
  );
  return row?.n ?? 0;
}

export function libraryTotals(): { talks: number; bytes: number; speakers: number } {
  const row = sqlite.getFirstSync<{ talks: number; bytes: number; speakers: number }>(
    `SELECT COUNT(*) AS talks,
            COALESCE(SUM(size_bytes), 0) AS bytes,
            COUNT(DISTINCT speaker_id) AS speakers
     FROM talks WHERE missing_since IS NULL`,
  );
  return row ?? { talks: 0, bytes: 0, speakers: 0 };
}

/** §15.2 CONTINUE — the single most recently touched unfinished talk. */
export function continueListening(): TalkListItem | null {
  const row = sqlite.getFirstSync<RawTalkRow>(
    `${TALK_SELECT}
     WHERE t.missing_since IS NULL
       AND ls.position_sec > 30
       AND COALESCE(ls.played, 0) = 0
     ORDER BY ls.updated_at DESC
     LIMIT 1`,
  );
  return row ? toItem(row) : null;
}

/** §15.2 PICK UP WHERE YOU LEFT OFF — started but unfinished, excluding the top card. */
export function inProgress(limit = 10, excludeId?: string): TalkListItem[] {
  const rows = sqlite.getAllSync<RawTalkRow>(
    `${TALK_SELECT}
     WHERE t.missing_since IS NULL
       AND ls.position_sec > 30
       AND COALESCE(ls.played, 0) = 0
       AND (? IS NULL OR t.id != ?)
     ORDER BY ls.updated_at DESC
     LIMIT ?`,
    [excludeId ?? null, excludeId ?? '', limit],
  );
  return rows.map(toItem);
}

/** §15.2 UP NEXT — the queue, in fractional-order-key order (§12.4). */
export function upNext(limit = 12): TalkListItem[] {
  const rows = sqlite.getAllSync<RawTalkRow>(
    `${TALK_SELECT}
     JOIN queue q ON q.talk_id = t.id
     WHERE t.missing_since IS NULL
     ORDER BY q.order_key, t.id
     LIMIT ?`,
    [limit],
  );
  return rows.map(toItem);
}

/** §15.2 RECENTLY ADDED — newest by importedAt. */
export function recentlyAdded(limit = 12): TalkListItem[] {
  const rows = sqlite.getAllSync<RawTalkRow>(
    `${TALK_SELECT}
     WHERE t.missing_since IS NULL
     ORDER BY t.imported_at DESC
     LIMIT ?`,
    [limit],
  );
  return rows.map(toItem);
}

/** §15.2 FROM YOUR GREATEST OF ALL — shuffled from the 5-star collection. */
export function fromFiveStar(limit = 12): TalkListItem[] {
  const rows = sqlite.getAllSync<RawTalkRow>(
    `${TALK_SELECT}
     WHERE t.missing_since IS NULL AND ls.rating = 5
     ORDER BY RANDOM()
     LIMIT ?`,
    [limit],
  );
  return rows.map(toItem);
}

export function getTalk(id: string): TalkListItem | null {
  const row = sqlite.getFirstSync<RawTalkRow>(`${TALK_SELECT} WHERE t.id = ?`, [id]);
  return row ? toItem(row) : null;
}

/**
 * §15.3 All Talks — keyset pagination on (title, id) so page N+1 costs the same as
 * page 1 no matter how deep the list goes. OFFSET would degrade linearly at 2,000 rows.
 */
export function talksPage(opts: { after?: { title: string; id: string }; limit?: number } = {}) {
  const limit = opts.limit ?? 50;
  const rows = opts.after
    ? sqlite.getAllSync<RawTalkRow>(
        `${TALK_SELECT}
         WHERE t.missing_since IS NULL AND (t.title, t.id) > (?, ?)
         ORDER BY t.title, t.id LIMIT ?`,
        [opts.after.title, opts.after.id, limit],
      )
    : sqlite.getAllSync<RawTalkRow>(
        `${TALK_SELECT}
         WHERE t.missing_since IS NULL
         ORDER BY t.title, t.id LIMIT ?`,
        [limit],
      );
  return rows.map(toItem);
}

export function talksBySpeaker(speakerId: string, limit = 200): TalkListItem[] {
  const rows = sqlite.getAllSync<RawTalkRow>(
    `${TALK_SELECT}
     WHERE t.missing_since IS NULL AND t.speaker_id = ?
     ORDER BY t.published_at DESC, t.title
     LIMIT ?`,
    [speakerId, limit],
  );
  return rows.map(toItem);
}

// ─── Speakers (§15.3) ───────────────────────────────────────────────────────────

export interface SpeakerListItem {
  id: string;
  name: string;
  role: string;
  successionOrder: number | null;
  photoPath: string | null;
  gradientSeed: string;
  talkCount: number;
  unplayedCount: number;
}

/**
 * Sectioned by role, prophets first and ordered by succession. The role ordering is a
 * CASE rather than an alphabetical sort because "Apostles before Others before
 * Prophets" is not what §15.3 means.
 */
export function speakerList(): SpeakerListItem[] {
  return sqlite.getAllSync<SpeakerListItem>(
    `SELECT s.id, s.name, s.role,
            s.succession_order AS successionOrder,
            s.photo_path AS photoPath, s.gradient_seed AS gradientSeed,
            COUNT(t.id) AS talkCount,
            SUM(CASE WHEN COALESCE(ls.played, 0) = 0 THEN 1 ELSE 0 END) AS unplayedCount
     FROM speakers s
     LEFT JOIN talks t ON t.speaker_id = s.id AND t.missing_since IS NULL
     LEFT JOIN listen_state ls ON ls.talk_id = t.id
     GROUP BY s.id
     HAVING talkCount > 0
     ORDER BY CASE s.role
                WHEN 'prophet' THEN 0 WHEN 'apostle' THEN 1 WHEN 'seventy' THEN 2
                WHEN 'auxiliary' THEN 3 WHEN 'scholar' THEN 4 ELSE 5 END,
              COALESCE(s.succession_order, 9999),
              s.sort_name`,
  );
}

// ─── Search (§13) ───────────────────────────────────────────────────────────────

export interface SearchHit {
  id: string;
  title: string;
  speakerName: string;
  durationSec: number | null;
  snippet: string;
}

/**
 * §6.2's query, verbatim: FTS5 returns rowids, so it must join back to `talks` to get
 * the stable `id`. bm25 weights title ≫ speaker > transcript.
 */
export function searchTalks(query: string, limit = 50): SearchHit[] {
  const match = toFtsQuery(query);
  if (!match) return [];
  try {
    return sqlite.getAllSync<SearchHit>(
      `SELECT t.id, t.title, t.speaker_name AS speakerName, t.duration_sec AS durationSec,
              snippet(talks_fts, 1, '[', ']', '…', 24) AS snippet
       FROM talks_fts f
       JOIN talks t ON t.rowid = f.rowid
       WHERE talks_fts MATCH ?1 AND t.missing_since IS NULL
       ORDER BY bm25(talks_fts, 10.0, 1.0, 5.0)
       LIMIT ?2`,
      [match, limit],
    );
  } catch {
    // A malformed MATCH expression throws rather than returning nothing. The user is
    // mid-typing; an empty result reads better than a red screen.
    return [];
  }
}

/** How many talks actually have a transcript — §13 insists the footer be honest. */
export function transcriptCoverage(): number {
  const row = sqlite.getFirstSync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM talks WHERE transcript IS NOT NULL AND transcript != ''",
  );
  return row?.n ?? 0;
}

/**
 * Turn free text into a safe FTS5 prefix query. Quoting each term defuses the
 * operators (`"`, `*`, `:`, `NEAR`, `-`) that would otherwise make an ordinary phrase
 * like `charity - never` a syntax error.
 */
function toFtsQuery(raw: string): string {
  const terms = raw
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/["*:^]/g, ''))
    .filter(Boolean);
  if (!terms.length) return '';
  return terms.map((t, i) => (i === terms.length - 1 ? `"${t}"*` : `"${t}"`)).join(' AND ');
}

// ─── Storage (§15.11) ───────────────────────────────────────────────────────────

export interface StorageTotals {
  pinnedBytes: number;
  cachedBytes: number;
  cachedCount: number;
  pinnedCount: number;
}

/**
 * §11.3 rule 4: the disk figure sums all non-`pending` rows, INCLUDING `downloading`
 * and `failed` — they occupy real bytes. Anything else drifts from `du` and breaks
 * acceptance criterion 15 (within 1%).
 */
export function storageTotals(): StorageTotals {
  const row = sqlite.getFirstSync<StorageTotals>(
    `SELECT
       COALESCE(SUM(CASE WHEN pinned = 1 THEN bytes ELSE 0 END), 0) AS pinnedBytes,
       COALESCE(SUM(CASE WHEN pinned = 0 THEN bytes ELSE 0 END), 0) AS cachedBytes,
       COALESCE(SUM(CASE WHEN pinned = 0 THEN 1 ELSE 0 END), 0) AS cachedCount,
       COALESCE(SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END), 0) AS pinnedCount
     FROM cache_entries
     WHERE state != 'pending'`,
  );
  return row ?? { pinnedBytes: 0, cachedBytes: 0, cachedCount: 0, pinnedCount: 0 };
}

export interface CachedTalkRow {
  talkId: string;
  title: string;
  speakerName: string;
  bytes: number;
  pinned: boolean;
  rendition: string;
}

export function cachedTalks(pinned: boolean, limit = 100): CachedTalkRow[] {
  const rows = sqlite.getAllSync<Omit<CachedTalkRow, 'pinned'> & { pinned: number }>(
    `SELECT c.talk_id AS talkId, t.title, t.speaker_name AS speakerName,
            c.bytes, c.pinned, c.rendition
     FROM cache_entries c
     JOIN talks t ON t.id = c.talk_id
     WHERE c.state != 'pending' AND c.pinned = ?
     ORDER BY c.bytes DESC
     LIMIT ?`,
    [pinned ? 1 : 0, limit],
  );
  return rows.map((r) => ({ ...r, pinned: r.pinned === 1 }));
}

/** §15.2's warning strip and §15.14's list. Only rendered when non-empty. */
export function needsAttentionCount(): number {
  const row = sqlite.getFirstSync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM talks
     WHERE missing_since IS NOT NULL
        OR parse_confidence < 0.7
        OR flags LIKE '%needs-redownload%'
        OR flags LIKE '%needs-attribution%'
        OR flags LIKE '%download-failed%'
        OR flags LIKE '%unplayable-format%'`,
  );
  return row?.n ?? 0;
}
