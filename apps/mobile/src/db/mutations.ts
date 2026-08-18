/**
 * User-state mutations — ratings, favourites, bookmarks.
 *
 * ⚠️ EVERY mutation writes the domain row AND an outbox row IN ONE TRANSACTION.
 *
 * §12.2 is explicit about why: the flusher reads the outbox *payloads* as the
 * change-set, not as a dirty flag, because a 412 merge cannot be done correctly without
 * knowing which fields changed locally since the last successful push. Writing the
 * domain row outside that transaction — or skipping the outbox row — produces a change
 * that exists on this phone and silently never reaches any other device.
 */
import { getDeviceId, sqlite } from './client';
import { recordChange } from '../sync/outbox';
import { uuidv7 } from '@feast/core';

/** Ensure a listen_state row exists so later UPDATEs have something to touch. */
function ensureListenState(talkId: string, now: number): void {
  sqlite.runSync(
    `INSERT OR IGNORE INTO listen_state (talk_id, position_sec, played, play_count, updated_at, device_id)
     VALUES (?, 0, 0, 0, ?, ?)`,
    [talkId, now, getDeviceId()],
  );
}

/** §6.1 — 1..5, or null to clear. "_Greatest of All" maps to 5 (§9.4). */
export function setRating(talkId: string, rating: 1 | 2 | 3 | 4 | 5 | null): void {
  const now = Date.now();
  sqlite.execSync('BEGIN');
  try {
    ensureListenState(talkId, now);
    sqlite.runSync(`UPDATE listen_state SET rating = ?, updated_at = ? WHERE talk_id = ?`, [
      rating,
      now,
      talkId,
    ]);
    recordChange('listenState', talkId, 'upsert', { talkId, rating });
    sqlite.execSync('COMMIT');
  } catch (e) {
    sqlite.execSync('ROLLBACK');
    throw e;
  }
}

export function toggleFavorite(talkId: string): boolean {
  const now = Date.now();
  const row = sqlite.getFirstSync<{ favorite: number }>(
    `SELECT favorite FROM listen_state WHERE talk_id = ?`,
    [talkId],
  );
  const next = row?.favorite === 1 ? 0 : 1;

  sqlite.execSync('BEGIN');
  try {
    ensureListenState(talkId, now);
    sqlite.runSync(`UPDATE listen_state SET favorite = ?, updated_at = ? WHERE talk_id = ?`, [
      next,
      now,
      talkId,
    ]);
    recordChange('listenState', talkId, 'upsert', { talkId, favorite: next === 1 });
    sqlite.execSync('COMMIT');
  } catch (e) {
    sqlite.execSync('ROLLBACK');
    throw e;
  }
  return next === 1;
}

/** §6.1 — mark played/unplayed. `played` is monotonic across devices (§12.4). */
export function setPlayed(talkId: string, played: boolean): void {
  const now = Date.now();
  sqlite.execSync('BEGIN');
  try {
    ensureListenState(talkId, now);
    sqlite.runSync(
      `UPDATE listen_state
       SET played = ?, completed_at = CASE WHEN ? = 1 THEN ? ELSE NULL END, updated_at = ?
       WHERE talk_id = ?`,
      [played ? 1 : 0, played ? 1 : 0, now, now, talkId],
    );
    recordChange('listenState', talkId, 'upsert', { talkId, played });
    sqlite.execSync('COMMIT');
  } catch (e) {
    sqlite.execSync('ROLLBACK');
    throw e;
  }
}

export interface BookmarkRow {
  id: string;
  talkId: string;
  positionSec: number;
  label: string | null;
  createdAt: number;
}

/** §6.1 — a timestamped marker inside a talk. */
export function addBookmark(talkId: string, positionSec: number, label?: string): string {
  const now = Date.now();
  const id = uuidv7();
  sqlite.execSync('BEGIN');
  try {
    sqlite.runSync(
      `INSERT INTO bookmarks (id, talk_id, position_sec, label, created_at, updated_at, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, talkId, positionSec, label ?? null, now, now, getDeviceId()],
    );
    recordChange('bookmarks', id, 'upsert', { id, talkId, positionSec, label: label ?? null });
    sqlite.execSync('COMMIT');
  } catch (e) {
    sqlite.execSync('ROLLBACK');
    throw e;
  }
  return id;
}

/**
 * Soft delete — §12.4. A tombstone is the only way to express a removal across devices;
 * a hard DELETE would simply be re-created by the next pull from the other phone.
 */
export function removeBookmark(id: string): void {
  const now = Date.now();
  sqlite.execSync('BEGIN');
  try {
    sqlite.runSync(`UPDATE bookmarks SET deleted_at = ?, updated_at = ? WHERE id = ?`, [
      now,
      now,
      id,
    ]);
    recordChange('bookmarks', id, 'delete', { id });
    sqlite.execSync('COMMIT');
  } catch (e) {
    sqlite.execSync('ROLLBACK');
    throw e;
  }
}

export function bookmarksFor(talkId: string): BookmarkRow[] {
  return sqlite.getAllSync<BookmarkRow>(
    `SELECT id, talk_id AS talkId, position_sec AS positionSec, label, created_at AS createdAt
     FROM bookmarks
     WHERE talk_id = ? AND deleted_at IS NULL
     ORDER BY position_sec ASC`,
    [talkId],
  );
}

export function listenStateFor(
  talkId: string,
): { rating: number | null; favorite: boolean; played: boolean } {
  const row = sqlite.getFirstSync<{ rating: number | null; favorite: number; played: number }>(
    `SELECT rating, favorite, played FROM listen_state WHERE talk_id = ?`,
    [talkId],
  );
  return {
    rating: row?.rating ?? null,
    favorite: row?.favorite === 1,
    played: row?.played === 1,
  };
}
