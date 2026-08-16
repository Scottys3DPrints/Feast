import { createMMKV } from 'react-native-mmkv';
import { sqlite, getDeviceId } from '../db/client';
import { recordChange } from '../sync/outbox';

/**
 * Playback position persistence — SPEC §12.3, "the thing users notice".
 *
 * The rule that makes acceptance criterion 10 ("survives force-quit and resumes within
 * 1 second of where it stopped") achievable:
 *
 *   • MMKV every 1 s while playing. It is a synchronous memory-mapped write, so 1 Hz
 *     is effectively free and the resume guarantee is tight rather than approximate.
 *   • SQLite + outbox on pause, track change, background, and completion — NEVER at
 *     1 Hz. A SQLite write per second over a 2-hour lecture is 7,200 transactions.
 *   • On cold start, reconcile MMKV → SQLite, because the app may have been killed
 *     mid-talk and MMKV is then strictly ahead.
 */

const store = createMMKV({ id: 'feast.positions' });

const KEY_PREFIX = 'pos.';
const KEY_UPDATED = 'upd.';

export function writePositionFast(talkId: string, positionSec: number): void {
  store.set(`${KEY_PREFIX}${talkId}`, positionSec);
  store.set(`${KEY_UPDATED}${talkId}`, Date.now());
}

export function readPositionFast(talkId: string): number | null {
  return store.getNumber(`${KEY_PREFIX}${talkId}`) ?? null;
}

/**
 * Durable write, with the matching outbox row in the SAME transaction (§12.2).
 *
 * The transaction is not decorative: a position that reached `listen_state` but not the
 * outbox is a position that never syncs, and the user has no way to notice until they
 * pick up the other device and find themselves ten minutes behind.
 */
export function flushPosition(
  talkId: string,
  positionSec: number,
  opts: { played?: boolean; incrementPlayCount?: boolean } = {},
): void {
  const now = Date.now();
  const deviceId = getDeviceId();

  sqlite.execSync('BEGIN');
  try {
  sqlite.runSync(
    `INSERT INTO listen_state (talk_id, position_sec, played, play_count, completed_at, updated_at, device_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(talk_id) DO UPDATE SET
       -- §12.4: position is max() when neither side is completed — you got further on
       -- the other device. played is monotonic: true wins over false, always.
       position_sec = CASE WHEN excluded.played = 1 THEN excluded.position_sec
                           ELSE MAX(listen_state.position_sec, excluded.position_sec) END,
       played       = MAX(listen_state.played, excluded.played),
       play_count   = listen_state.play_count + excluded.play_count,
       completed_at = COALESCE(excluded.completed_at, listen_state.completed_at),
       updated_at   = excluded.updated_at,
       device_id    = excluded.device_id`,
    [
      talkId,
      positionSec,
      opts.played ? 1 : 0,
      opts.incrementPlayCount ? 1 : 0,
      opts.played ? now : null,
      now,
      deviceId,
    ],
  );

    // Changed fields only — §12.2. Sending the whole row would clobber a rating or
    // note another device set while this one was only tracking playback position.
    recordChange('listenState', talkId, 'upsert', {
      talkId,
      positionSec,
      ...(opts.played ? { played: true, completedAt: now } : {}),
      ...(opts.incrementPlayCount ? { playCount: currentPlayCount(talkId) } : {}),
    });

    sqlite.execSync('COMMIT');
  } catch (e) {
    sqlite.execSync('ROLLBACK');
    throw e;
  }
}

/** Read back the post-increment count, so the pushed value is absolute rather than a
 *  delta — §12.4 merges playCount with max(), which a delta would break. */
function currentPlayCount(talkId: string): number {
  return (
    sqlite.getFirstSync<{ play_count: number }>(
      'SELECT play_count FROM listen_state WHERE talk_id = ?',
      [talkId],
    )?.play_count ?? 0
  );
}

/** Cold-start reconciliation: MMKV is ahead whenever the app was killed mid-talk. */
export function reconcilePositions(): void {
  for (const key of store.getAllKeys()) {
    if (!key.startsWith(KEY_PREFIX)) continue;
    const talkId = key.slice(KEY_PREFIX.length);
    const position = store.getNumber(key);
    if (position == null || position <= 0) continue;

    const row = sqlite.getFirstSync<{ position_sec: number }>(
      'SELECT position_sec FROM listen_state WHERE talk_id = ?',
      [talkId],
    );
    if (!row || position > row.position_sec + 1) {
      flushPosition(talkId, position);
    }
  }
}

/**
 * §11.5: auto-mark played at 95%, or within 30 s of the end. Both bounds exist because
 * many talks end with a long musical tail that nobody sits through, and a 2-hour
 * lecture's last 5% is six minutes.
 */
export function shouldMarkPlayed(positionSec: number, durationSec: number): boolean {
  if (!durationSec || durationSec <= 0) return false;
  return positionSec / durationSec >= 0.95 || durationSec - positionSec <= 30;
}

/**
 * §11.5: prompt "resume from 14:32?" only when the talk is >5 min in AND >24 h stale.
 * Resuming silently is right for "I paused ten minutes ago"; asking is right for "I
 * left this in June".
 */
export function shouldPromptResume(talkId: string, positionSec: number): boolean {
  if (positionSec < 300) return false;
  const updated = store.getNumber(`${KEY_UPDATED}${talkId}`) ?? 0;
  return Date.now() - updated > 24 * 60 * 60 * 1000;
}
