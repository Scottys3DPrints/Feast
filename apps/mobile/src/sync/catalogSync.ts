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
import { classifySpeaker } from '@feast/core';
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

      /*
       * Speakers are derived, not published: the catalog stores a display name per talk,
       * and the speaker row is whatever that name implies.
       *
       * ⚠️ Role matters more than it looks. Library → Speakers is SECTIONED by role
       * (§15.3: Prophets first by succession order, then Apostles, then everyone else).
       * Inserting every catalog speaker as 'other' — which the first version did —
       * leaves both of those sections empty and buries Nelson alphabetically among 561
       * names. classifySpeaker only recognises Presidents and the Twelve and returns
       * 'other' for everyone else, because a wrong calling is worse than an unstated one.
       *
       * The UPDATE deliberately never downgrades: a role learned from the archive's own
       * folder structure (§9.4, which also carries succession order) is better evidence
       * than a name lookup, so it wins.
       */
      const { role, successionOrder } = classifySpeaker(talk.speaker);
      sqlite.runSync(
        `INSERT INTO speakers (id, name, sort_name, role, succession_order, aliases, gradient_seed)
         VALUES (?, ?, ?, ?, ?, '[]', ?)
         ON CONFLICT(id) DO UPDATE SET
           role = CASE WHEN speakers.role = 'other' THEN excluded.role ELSE speakers.role END,
           succession_order = COALESCE(speakers.succession_order, excluded.succession_order)`,
        [slug, talk.speaker || 'Unknown', sortNameFor(talk.speaker), role, successionOrder ?? null, color],
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

/**
 * Re-classify speakers already in the database.
 *
 * ⚠️ Needed because the catalog sync is incremental. Once the watermark has advanced,
 * a later run fetches nothing and therefore never revisits the 561 speaker rows already
 * written — so a fix to `classifySpeaker` would only reach speakers discovered in
 * future, and Prophets/Apostles would stay empty forever on this device.
 *
 * Cheap (hundreds of rows, no network) and idempotent, so it simply runs at startup.
 * Only ever promotes from 'other': a role learned from the archive's folder structure
 * (§9.4) is stronger evidence than a name lookup and must not be overwritten.
 */
export function reclassifySpeakers(): number {
  const rows = sqlite.getAllSync<{ id: string; name: string }>(
    `SELECT id, name FROM speakers WHERE role = 'other'`,
  );
  if (!rows.length) return 0;

  let changed = 0;
  sqlite.execSync('BEGIN');
  try {
    for (const row of rows) {
      const { role, successionOrder } = classifySpeaker(row.name);
      if (role === 'other') continue;
      sqlite.runSync(
        `UPDATE speakers
         SET role = ?, succession_order = COALESCE(succession_order, ?)
         WHERE id = ?`,
        [role, successionOrder ?? null, row.id],
      );
      changed += 1;
    }
    sqlite.execSync('COMMIT');
  } catch (e) {
    sqlite.execSync('ROLLBACK');
    throw e;
  }
  return changed;
}
