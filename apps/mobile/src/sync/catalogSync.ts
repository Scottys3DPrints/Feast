/**
 * Pull the shared catalog into SQLite.
 *
 * The catalog lives in Firestore; the app reads from SQLite. This is the bridge, and it
 * runs one way only — the phone never writes to `catalog/` (the rules forbid it, and the
 * desktop CLI is the single writer, §6.3's one-writer-per-file discipline carried over).
 *
 * ⚠️ TWO THINGS THAT LOOK LIKE DETAILS AND ARE NOT:
 *
 * 1. `archive_path` holds an ABSOLUTE URL for catalog talks, not a provider-relative
 *    path. Everything imported from OneDrive stores a logical path like
 *    "Talks/By Speaker/…/x.mp3" which the StorageProvider resolves to a signed URL at
 *    play time (§7.1). A catalog talk is already a public URL and needs no resolution,
 *    so the player checks for a scheme and skips the provider entirely. One column,
 *    two meanings, distinguished by shape — documented here because the alternative
 *    was a second column that is null 90% of the time.
 *
 * 2. Talks are keyed by `externalId`, which is stable per source. Re-syncing therefore
 *    updates rather than duplicating, and the user's ratings and collection memberships
 *    — which reference talk ids — survive every catalog refresh.
 */
import type { CatalogTalk } from '@feast/sync';
import { getSyncBackend } from './backend';
import { getMeta, setMeta, sqlite } from '../db/client';
import { clearDemoSeed, hasDemoSeed } from '../db/demoSeed';

const LAST_SYNC_KEY = 'catalog_last_sync';

export interface CatalogSyncResult {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: boolean;
}

/** Speaker display name → stable slug. "Russell M. Nelson" → "russell-m-nelson". */
export function speakerSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unknown'
  );
}

/**
 * A deterministic colour per speaker, so a speaker's artwork never changes between
 * launches or devices. §21 Q7 chose generated gradients over sourcing portraits.
 */
function colorFor(slug: string): string {
  const palette = [
    '#3A4A6B',
    '#5B4A6B',
    '#6B5230',
    '#2F5B52',
    '#6B3A3A',
    '#3E4C5B',
    '#4A6B5B',
    '#5B3A5B',
  ];
  let hash = 0;
  for (let i = 0; i < slug.length; i += 1) hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length] ?? palette[0]!;
}

function yearOf(talk: CatalogTalk): number | null {
  if (talk.publishedAt) {
    const y = Number.parseInt(talk.publishedAt.slice(0, 4), 10);
    if (Number.isFinite(y)) return y;
  }
  const m = /(\d{4})/.exec(talk.eventName ?? '');
  return m?.[1] ? Number.parseInt(m[1], 10) : null;
}

/**
 * Fetch and apply. Safe to call on every foreground; the watermark makes a no-change
 * sync cost one query rather than 5,000 document reads.
 */
export async function syncCatalog(opts: { force?: boolean } = {}): Promise<CatalogSyncResult> {
  const backend = getSyncBackend();
  if (!backend) return { fetched: 0, inserted: 0, updated: 0, skipped: true };

  const since = opts.force ? 0 : Number.parseInt(getMeta(LAST_SYNC_KEY) ?? '0', 10) || 0;
  const talks = await backend.fetchCatalog(since);
  if (!talks.length) return { fetched: 0, inserted: 0, updated: 0, skipped: false };

  let inserted = 0;
  let updated = 0;
  let watermark = since;
  const now = Date.now();

  sqlite.execSync('BEGIN');
  try {
    for (const talk of talks) {
      const slug = speakerSlug(talk.speaker);
      const color = colorFor(slug);

      // Speakers are derived, not published: the catalog stores a display name per talk,
      // and the speaker row is whatever that name implies. `INSERT OR IGNORE` keeps any
      // richer record an earlier import already created (role, succession order).
      sqlite.runSync(
        `INSERT OR IGNORE INTO speakers (id, name, sort_name, role, aliases, gradient_seed)
         VALUES (?, ?, ?, 'other', '[]', ?)`,
        [slug, talk.speaker || 'Unknown', sortNameFor(talk.speaker), color],
      );

      const existing = sqlite.getFirstSync<{ id: string }>(`SELECT id FROM talks WHERE id = ?`, [
        talk.externalId,
      ]);

      sqlite.runSync(
        `INSERT INTO talks (
           id, content_hash, title, speaker_id, speaker_name,
           duration_sec, published_at, recorded_year, event_name, session_name,
           archive_path, size_bytes, mime_type, artwork_color,
           source, imported_at, original_paths, parse_confidence, flags
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'audio/mpeg', ?, ?, ?, '[]', 1.0, '[]')
         ON CONFLICT(id) DO UPDATE SET
           title        = excluded.title,
           speaker_id   = excluded.speaker_id,
           speaker_name = excluded.speaker_name,
           duration_sec = COALESCE(excluded.duration_sec, talks.duration_sec),
           event_name   = excluded.event_name,
           session_name = excluded.session_name,
           -- Refreshing the URL matters: the Church's audio hashes are opaque and could
           -- rotate, and a stale one plays as a 404 that looks like a broken talk.
           archive_path = excluded.archive_path,
           size_bytes   = excluded.size_bytes`,
        [
          talk.externalId,
          talk.externalId,
          talk.title,
          slug,
          talk.speaker || 'Unknown',
          talk.durationSec ?? null,
          talk.publishedAt ? Date.parse(talk.publishedAt) || null : null,
          yearOf(talk),
          talk.eventName ?? null,
          talk.sessionName ?? null,
          talk.audioUrl,
          talk.sizeBytes ?? 0,
          color,
          talk.source,
          now,
        ],
      );

      if (existing) updated += 1;
      else inserted += 1;
      if (talk.updatedAt > watermark) watermark = talk.updatedAt;
    }
    sqlite.execSync('COMMIT');
  } catch (e) {
    sqlite.execSync('ROLLBACK');
    throw e;
  }

  setMeta(LAST_SYNC_KEY, String(watermark));
  setMeta('last_catalog_sync', String(now));

  /*
   * The demo seed has done its job — remove it.
   *
   * It exists only so the UI can be judged before a real catalog exists, and its talks
   * are deliberately unplayable. Leaving fourteen fake rows mixed into five thousand
   * real ones would mean a library where some talks silently refuse to play, which is a
   * far worse failure than an empty screen ever was.
   */
  if (inserted > 0 && hasDemoSeed()) {
    try {
      clearDemoSeed();
    } catch (error) {
      console.warn('[catalog] could not clear the demo seed:', error);
    }
  }

  return { fetched: talks.length, inserted, updated, skipped: false };
}

/** "Russell M. Nelson" → "Nelson, Russell M.", for alphabetical speaker lists. */
function sortNameFor(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  const last = parts.pop() ?? '';
  return `${last}, ${parts.join(' ')}`;
}

export function catalogTalkCount(): number {
  const row = sqlite.getFirstSync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM talks WHERE source IN ('general-conference','byu-speeches')`,
  );
  return row?.n ?? 0;
}
