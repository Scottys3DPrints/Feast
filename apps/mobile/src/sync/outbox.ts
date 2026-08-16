/**
 * The outbox — SPEC §12.2.
 *
 * Every mutation writes the domain table AND a row here, in the SAME transaction. That
 * atomicity is the whole point: a change that reached the table but not the outbox is a
 * change that never syncs, and the user has no way to discover it.
 *
 * ⚠️ The outbox stores the CHANGED FIELDS ONLY, not the whole record. §12.2 is blunt
 * about why: a conflict cannot be merged correctly without knowing which fields *this*
 * device changed since its last successful push. Re-serialising the local row on
 * conflict would clobber another device's concurrent edit to a field this device never
 * touched. If you find yourself ignoring `payload`, the outbox is dead weight — but
 * then there is no correct conflict path either, so don't.
 */
import { sqlite, getDeviceId } from '../db/client';
import { uuidv7 } from '@feast/core';
import type { SyncEntity } from '@feast/sync';

export interface OutboxRow {
  id: string;
  entity: SyncEntity;
  entityId: string;
  op: 'upsert' | 'delete';
  payload: Record<string, unknown>;
  createdAt: number;
  attempts: number;
}

/**
 * Record a change for sync. Call INSIDE the transaction that wrote the domain row.
 *
 * `updatedAt` and `deviceId` are stamped here rather than by callers, because every
 * merge rule in §12.4 depends on them and a caller that forgets one produces a record
 * that silently loses every conflict.
 */
export function recordChange(
  entity: SyncEntity,
  entityId: string,
  op: 'upsert' | 'delete',
  payload: Record<string, unknown>,
): void {
  const now = Date.now();
  sqlite.runSync(
    `INSERT INTO outbox (id, entity, entity_id, op, payload, created_at, attempts)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [
      uuidv7(),
      entity,
      entityId,
      op,
      JSON.stringify({ ...payload, updatedAt: now, deviceId: getDeviceId() }),
      now,
    ],
  );
}

export function pendingChanges(limit = 500): OutboxRow[] {
  const rows = sqlite.getAllSync<{
    id: string;
    entity: string;
    entity_id: string;
    op: string;
    payload: string;
    created_at: number;
    attempts: number;
  }>(`SELECT * FROM outbox ORDER BY created_at LIMIT ?`, [limit]);

  return rows.map((r) => ({
    id: r.id,
    entity: r.entity as SyncEntity,
    entityId: r.entity_id,
    op: r.op as 'upsert' | 'delete',
    payload: safeParse(r.payload),
    createdAt: r.created_at,
    attempts: r.attempts,
  }));
}

export function clearChanges(ids: string[]): void {
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  sqlite.runSync(`DELETE FROM outbox WHERE id IN (${placeholders})`, ids);
}

export function markAttempted(ids: string[]): void {
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  sqlite.runSync(`UPDATE outbox SET attempts = attempts + 1 WHERE id IN (${placeholders})`, ids);
}

export function pendingCount(): number {
  return sqlite.getFirstSync<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox`)?.n ?? 0;
}

function safeParse(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
