/**
 * A small demo catalog, so the UI can be judged with content in it.
 *
 * ⚠️ THIS IS SCAFFOLDING, NOT A FEATURE. It exists because every screen in a library
 * app is an empty state until `feast-ingest` (Phase 2) produces a real catalog.json,
 * and an empty list teaches you nothing about whether a list design works.
 *
 * Three rules keep it from ever being mistaken for real data:
 *
 *  1. Every row it writes is `source: 'manual'` with ids prefixed `demo-`, so
 *     `clearDemoSeed()` can remove exactly its own rows and nothing else.
 *  2. It runs ONCE, and only when the talks table is completely empty. A real catalog
 *     sync therefore always wins — §12.1's insert path never competes with it.
 *  3. The talks have no playable path. `archivePath` points at a location that does not
 *     resolve, so tapping play surfaces an honest "file not found" rather than
 *     pretending. The demo is for looking at, not listening to.
 *
 * Delete this file the day `feast import` runs for real.
 */
import { sqlite, getDeviceId } from './client';

const DEMO_PREFIX = 'demo-';

/** Talks are drawn from the archive's real shape (§1) so the design meets real strings. */
const SPEAKERS: Array<{
  id: string;
  name: string;
  sort: string;
  role: string;
  order?: number;
  seed: string;
}> = [
  { id: 'demo-russell-m-nelson', name: 'Russell M. Nelson', sort: 'Nelson, Russell M.', role: 'prophet', order: 17, seed: '3A4A6B' },
  { id: 'demo-thomas-s-monson', name: 'Thomas S. Monson', sort: 'Monson, Thomas S.', role: 'prophet', order: 16, seed: '3E4C5B' },
  { id: 'demo-gordon-b-hinckley', name: 'Gordon B. Hinckley', sort: 'Hinckley, Gordon B.', role: 'prophet', order: 15, seed: '6B5230' },
  { id: 'demo-jeffrey-r-holland', name: 'Jeffrey R. Holland', sort: 'Holland, Jeffrey R.', role: 'apostle', seed: '6B3A3A' },
  { id: 'demo-neal-a-maxwell', name: 'Neal A. Maxwell', sort: 'Maxwell, Neal A.', role: 'apostle', seed: '5B4A6B' },
  { id: 'demo-hugh-nibley', name: 'Hugh Nibley', sort: 'Nibley, Hugh', role: 'scholar', seed: '2F5B52' },
  { id: 'demo-john-bytheway', name: 'John Bytheway', sort: 'Bytheway, John', role: 'other', seed: '6B5230' },
  { id: 'demo-hank-smith', name: 'Hank Smith', sort: 'Smith, Hank', role: 'other', seed: '4A6B5B' },
];

const SERIES: Array<{ id: string; name: string; kind: string; speakerId?: string; parts: number }> = [
  { id: 'demo-17-points', name: '17 Points of the True Church', kind: 'lecture', parts: 9 },
  { id: 'demo-dead-sea-scrolls', name: 'Dead Sea Scrolls', kind: 'lecture', speakerId: 'demo-hugh-nibley', parts: 12 },
];

interface DemoTalk {
  id: string;
  title: string;
  speakerId: string;
  durationSec: number;
  year: number;
  event?: string;
  session?: string;
  sizeBytes: number;
  seriesId?: string;
  part?: number;
  color: string;
  rating?: number;
  played?: boolean;
  positionSec?: number;
}

const TALKS: DemoTalk[] = [
  { id: 'demo-t01', title: 'Think Celestial!', speakerId: 'demo-russell-m-nelson', durationSec: 1300, year: 2023, event: 'October 2023 General Conference', session: 'Sunday Morning Session', sizeBytes: 18_900_000, color: '#3A4A6B', rating: 5, positionSec: 872 },
  { id: 'demo-t02', title: 'Broken Things to Mend', speakerId: 'demo-jeffrey-r-holland', durationSec: 800, year: 2006, event: 'April 2006 General Conference', session: 'Sunday Morning Session', sizeBytes: 12_100_000, color: '#6B3A3A', rating: 5, positionSec: 316 },
  { id: 'demo-t03', title: 'The Greatest Possession', speakerId: 'demo-gordon-b-hinckley', durationSec: 1120, year: 1994, event: 'October 1994 General Conference', session: 'Saturday Afternoon Session', sizeBytes: 15_400_000, color: '#6B5230' },
  { id: 'demo-t04', title: 'Righteous Warriors — Lessons from the War Chapters', speakerId: 'demo-john-bytheway', durationSec: 3540, year: 2006, event: 'Education Week', sizeBytes: 138_000_000, color: '#6B5230', rating: 5 },
  { id: 'demo-t05', title: 'The Meaning of the Temple', speakerId: 'demo-hugh-nibley', durationSec: 4210, year: 1992, event: 'Lectures', sizeBytes: 96_000_000, color: '#2F5B52' },
  { id: 'demo-t06', title: 'Break Up With The World', speakerId: 'demo-hank-smith', durationSec: 3180, year: 2021, event: 'Education Week', sizeBytes: 149_000_000, color: '#4A6B5B' },
  { id: 'demo-t07', title: 'Willing to Submit', speakerId: 'demo-neal-a-maxwell', durationSec: 960, year: 1985, event: 'April 1985 General Conference', session: 'Sunday Afternoon Session', sizeBytes: 13_200_000, color: '#5B4A6B', played: true },
  { id: 'demo-t08', title: 'The Prophet Joseph Smith', speakerId: 'demo-thomas-s-monson', durationSec: 1040, year: 2005, event: 'October 2005 General Conference', session: 'Priesthood Session', sizeBytes: 14_100_000, color: '#3E4C5B', played: true },
  { id: 'demo-t09', title: 'Part 03 — The True Church Has Apostles', speakerId: 'demo-john-bytheway', durationSec: 1860, year: 1998, seriesId: 'demo-17-points', part: 3, sizeBytes: 26_400_000, color: '#6B5230', positionSec: 640 },
  { id: 'demo-t10', title: 'Part 04 — Officers Called of God', speakerId: 'demo-john-bytheway', durationSec: 1790, year: 1998, seriesId: 'demo-17-points', part: 4, sizeBytes: 25_100_000, color: '#6B5230' },
  { id: 'demo-t11', title: 'Discovery and Importance', speakerId: 'demo-hugh-nibley', durationSec: 2980, year: 1986, seriesId: 'demo-dead-sea-scrolls', part: 6, sizeBytes: 41_000_000, color: '#2F5B52' },
  { id: 'demo-t12', title: 'Lifted Up upon the Cross', speakerId: 'demo-jeffrey-r-holland', durationSec: 910, year: 2023, event: 'October 2023 General Conference', session: 'Sunday Morning Session', sizeBytes: 13_600_000, color: '#6B3A3A', rating: 4 },
  { id: 'demo-t13', title: 'The Pure Love of Christ', speakerId: 'demo-neal-a-maxwell', durationSec: 780, year: 1992, event: 'April 1992 General Conference', session: 'Saturday Morning Session', sizeBytes: 11_200_000, color: '#5B4A6B' },
  { id: 'demo-t14', title: 'Come, Follow Me', speakerId: 'demo-russell-m-nelson', durationSec: 1180, year: 2019, event: 'April 2019 General Conference', session: 'Sunday Afternoon Session', sizeBytes: 16_300_000, color: '#3A4A6B', played: true },
];

const COLLECTIONS: Array<{ id: string; name: string; desc: string; pinned: boolean; talks: string[] }> = [
  {
    id: 'demo-c-greatest',
    name: 'Greatest of All',
    desc: 'The ones worth coming back to.',
    pinned: true,
    talks: ['demo-t01', 'demo-t02', 'demo-t04', 'demo-t12'],
  },
  {
    id: 'demo-c-second',
    name: 'Second Greatest',
    desc: '',
    pinned: false,
    talks: ['demo-t03', 'demo-t13'],
  },
  {
    id: 'demo-c-tobeheard',
    name: 'To Be Heard',
    desc: 'Queued up for the drive.',
    pinned: false,
    talks: ['demo-t05', 'demo-t06', 'demo-t11'],
  },
];

/** True when the library has no talks at all — the only moment seeding is allowed. */
function libraryIsEmpty(): boolean {
  const row = sqlite.getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM talks');
  return (row?.n ?? 0) === 0;
}

export function hasDemoSeed(): boolean {
  const row = sqlite.getFirstSync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM talks WHERE id LIKE '${DEMO_PREFIX}%'`,
  );
  return (row?.n ?? 0) > 0;
}

/**
 * Remove every demo row. Called before a real catalog is applied, and available from
 * Settings so the user is never stuck looking at fake talks.
 */
export function clearDemoSeed(): void {
  const like = `${DEMO_PREFIX}%`;
  sqlite.execSync('BEGIN');
  try {
    for (const table of [
      'collection_members',
      'talk_tags',
      'listen_state',
      'queue',
      'cache_entries',
    ]) {
      sqlite.runSync(`DELETE FROM ${table} WHERE talk_id LIKE ?`, [like]);
    }
    sqlite.runSync('DELETE FROM collection_members WHERE collection_id LIKE ?', [like]);
    sqlite.runSync('DELETE FROM collections WHERE id LIKE ?', [like]);
    sqlite.runSync('DELETE FROM talks WHERE id LIKE ?', [like]);
    sqlite.runSync('DELETE FROM series WHERE id LIKE ?', [like]);
    sqlite.runSync('DELETE FROM speakers WHERE id LIKE ?', [like]);
    sqlite.execSync('COMMIT');
  } catch (e) {
    sqlite.execSync('ROLLBACK');
    throw e;
  }
}

/** Seed once, and only into a genuinely empty library. Safe to call on every launch. */
export function seedDemoCatalogIfEmpty(): void {
  if (!libraryIsEmpty()) return;

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const deviceId = getDeviceId();

  sqlite.execSync('BEGIN');
  try {
    for (const s of SPEAKERS) {
      sqlite.runSync(
        `INSERT INTO speakers (id, name, sort_name, role, succession_order, aliases, gradient_seed)
         VALUES (?, ?, ?, ?, ?, '[]', ?)`,
        [s.id, s.name, s.sort, s.role, s.order ?? null, s.seed],
      );
    }

    for (const s of SERIES) {
      sqlite.runSync(
        `INSERT INTO series (id, name, kind, speaker_id, total_parts) VALUES (?, ?, ?, ?, ?)`,
        [s.id, s.name, s.kind, s.speakerId ?? null, s.parts],
      );
    }

    for (const t of TALKS) {
      const speaker = SPEAKERS.find((s) => s.id === t.speakerId);
      sqlite.runSync(
        `INSERT INTO talks (
           id, content_hash, title, speaker_id, speaker_name, series_id, part_number,
           duration_sec, recorded_year, event_name, session_name,
           archive_path, size_bytes, mime_type, artwork_color,
           source, imported_at, original_paths, parse_confidence, flags
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'audio/mpeg', ?, 'manual', ?, '[]', 1.0, '[]')`,
        [
          t.id,
          `${DEMO_PREFIX}hash-${t.id}`,
          t.title,
          t.speakerId,
          speaker?.name ?? '',
          t.seriesId ?? null,
          t.part ?? null,
          t.durationSec,
          t.year,
          t.event ?? null,
          t.session ?? null,
          // Deliberately unresolvable — see the header note.
          `Talks/_demo/${t.id}.mp3`,
          t.sizeBytes,
          t.color,
          now,
        ],
      );

      if (t.rating || t.played || t.positionSec) {
        sqlite.runSync(
          `INSERT INTO listen_state (talk_id, position_sec, played, play_count, rating, favorite, updated_at, device_id)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
          [
            t.id,
            t.positionSec ?? 0,
            t.played ? 1 : 0,
            t.played ? 1 : 0,
            t.rating ?? null,
            now,
            deviceId,
          ],
        );
      }
    }

    let sortOrder = 0;
    for (const c of COLLECTIONS) {
      sqlite.runSync(
        `INSERT INTO collections (id, name, description, kind, origin, sort_order, pinned, updated_at, device_id)
         VALUES (?, ?, ?, 'user', 'catalog', ?, ?, ?, ?)`,
        [c.id, c.name, c.desc || null, sortOrder++, c.pinned ? 1 : 0, now, deviceId],
      );
      let i = 0;
      for (const talkId of c.talks) {
        sqlite.runSync(
          `INSERT INTO collection_members (collection_id, talk_id, order_key, origin, added_at, updated_at, device_id)
           VALUES (?, ?, ?, 'catalog', ?, ?, ?)`,
          [c.id, talkId, `a${i++}:${deviceId}`, now, now, deviceId],
        );
      }
    }

    /*
     * ⚠️ NO FAKE cache_entries ROWS.
     *
     * An earlier version seeded two here, with `local_path = ''`, so the Storage screen
     * and the residency badges would have something to show. That was a lie about the
     * filesystem, and it crashed the app at launch: reconcileCache() builds a
     * `new File(local_path)` for every row, and expo-file-system THROWS
     * `IllegalArgumentException: URI is not absolute` on an empty string rather than
     * returning a missing-file handle. Startup runs before first paint, so the whole
     * app died on a row invented purely for looks.
     *
     * The badges now correctly show every demo talk as cloud-only, which is the truth:
     * these talks have no audio anywhere. CacheManager also guards the malformed case
     * now, but the real fix is not to write rows that describe files that do not exist.
     */

    for (const talkId of ['demo-t05', 'demo-t06', 'demo-t11']) {
      sqlite.runSync(
        `INSERT INTO queue (talk_id, order_key, added_at) VALUES (?, ?, ?)`,
        [talkId, `a${talkId}`, now],
      );
    }

    sqlite.execSync('COMMIT');
    void nowIso;
  } catch (e) {
    sqlite.execSync('ROLLBACK');
    throw e;
  }
}
