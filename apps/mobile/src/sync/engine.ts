/**
 * The sync engine — SPEC §12.2, §12.4, adapted from state.json to Firestore.
 *
 * Two directions, deliberately asymmetric:
 *
 *   push   outbox → Firestore. Changed fields only, batched.
 *   pull   Firestore → SQLite. Cursor-based on cold start, live listeners while
 *          foregrounded.
 *
 * SQLite remains the source of truth for READS (§3.1 — browsing must work offline,
 * instantly, always). Firestore is the bus, not the database the UI queries.
 */
import { sqlite, getMeta, setMeta } from '../db/client';
import { getSyncBackend } from './backend';
import { clearChanges, markAttempted, pendingChanges } from './outbox';
import type { SyncChange, SyncEntity, Unsubscribe } from '@feast/sync';

/** Entities that sync. Talks/speakers/series come from the catalog, not from here. */
const USER_ENTITIES: SyncEntity[] = [
  'collections',
  'collectionMembers',
  'tags',
  'talkTags',
  'listenState',
  'bookmarks',
  'queue',
];

const CURSOR_KEY = 'sync_cursor';

let flushing = false;
let listeners: Unsubscribe | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

// ─── Push ─────────────────────────────────────────────────────────────────────────

export async function flush(): Promise<void> {
  const backend = getSyncBackend();
  if (!backend || !backend.currentUserId()) return;
  if (flushing) return;

  const batch = pendingChanges();
  if (!batch.length) return;

  flushing = true;
  try {
    await backend.push(
      batch.map((row) => ({
        entity: row.entity,
        id: row.entityId,
        op: row.op,
        payload: row.payload,
      })),
    );
    clearChanges(batch.map((r) => r.id));
  } catch {
    // Keep the rows. §12.2: 5xx/network increments attempts and backs off, it never
    // drops the change — a dropped change is silent data loss the user cannot detect.
    markAttempted(batch.map((r) => r.id));
  } finally {
    flushing = false;
  }
}

// ─── Pull ─────────────────────────────────────────────────────────────────────────

/**
 * Apply a remote change to SQLite using §12.4's merge rules.
 *
 * ⚠️ Generic LWW is WRONG for listen state, and this is the part that is easy to get
 * wrong in a way users notice:
 *
 *   positionSec  → max() when neither side completed. You got further on the other
 *                  device; taking the newer write instead would rewind you.
 *   played       → monotonic, true beats false, always.
 *   playCount    → max().
 *   everything else → LWW on updatedAt.
 */
function applyChange(change: SyncChange): void {
  const { entity, id, data } = change;
  if (!data) return; // hard removal; tombstones arrive as normal records with deletedAt

  const remoteUpdated = typeof data['updatedAt'] === 'number' ? (data['updatedAt'] as number) : 0;

  if (entity === 'listenState') {
    sqlite.runSync(
      `INSERT INTO listen_state (talk_id, position_sec, played, play_count, completed_at, rating, favorite, note, updated_at, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(talk_id) DO UPDATE SET
         position_sec = CASE WHEN excluded.played = 1 THEN excluded.position_sec
                             ELSE MAX(listen_state.position_sec, excluded.position_sec) END,
         played       = MAX(listen_state.played, excluded.played),
         play_count   = MAX(listen_state.play_count, excluded.play_count),
         completed_at = COALESCE(excluded.completed_at, listen_state.completed_at),
         rating       = CASE WHEN excluded.updated_at > listen_state.updated_at
                             THEN excluded.rating ELSE listen_state.rating END,
         favorite     = CASE WHEN excluded.updated_at > listen_state.updated_at
                             THEN excluded.favorite ELSE listen_state.favorite END,
         note         = CASE WHEN excluded.updated_at > listen_state.updated_at
                             THEN excluded.note ELSE listen_state.note END,
         updated_at   = MAX(listen_state.updated_at, excluded.updated_at)`,
      [
        id,
        num(data['positionSec']),
        bool(data['played']),
        num(data['playCount']),
        data['completedAt'] == null ? null : num(data['completedAt']),
        data['rating'] == null ? null : num(data['rating']),
        bool(data['favorite']),
        (data['note'] as string | null) ?? null,
        remoteUpdated,
        (data['deviceId'] as string) ?? '',
      ],
    );
    return;
  }

  if (entity === 'collections') {
    sqlite.runSync(
      `INSERT INTO collections (id, name, description, kind, origin, icon, color, sort_order, parent_id, smart_query, pinned, updated_at, deleted_at, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, description=excluded.description, icon=excluded.icon,
         color=excluded.color, sort_order=excluded.sort_order, parent_id=excluded.parent_id,
         pinned=excluded.pinned, deleted_at=excluded.deleted_at,
         updated_at=excluded.updated_at, device_id=excluded.device_id
       WHERE excluded.updated_at > collections.updated_at`,
      [
        id,
        (data['name'] as string) ?? 'Untitled',
        (data['description'] as string | null) ?? null,
        (data['kind'] as string) ?? 'user',
        (data['origin'] as string) ?? 'device',
        (data['icon'] as string | null) ?? null,
        (data['color'] as string | null) ?? null,
        num(data['sortOrder']),
        (data['parentId'] as string | null) ?? null,
        data['smartQuery'] ? JSON.stringify(data['smartQuery']) : null,
        bool(data['pinned']),
        remoteUpdated,
        data['deletedAt'] == null ? null : num(data['deletedAt']),
        (data['deviceId'] as string) ?? '',
      ],
    );
    return;
  }

  if (entity === 'collectionMembers') {
    // Composite id, joined by the backend. Split it back apart here.
    const [collectionId, talkId] = id.split('__');
    if (!collectionId || !talkId) return;
    sqlite.runSync(
      `INSERT INTO collection_members (collection_id, talk_id, order_key, origin, added_at, updated_at, deleted_at, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(collection_id, talk_id) DO UPDATE SET
         order_key=excluded.order_key, deleted_at=excluded.deleted_at,
         updated_at=excluded.updated_at, device_id=excluded.device_id
       WHERE excluded.updated_at > collection_members.updated_at`,
      [
        collectionId,
        talkId,
        (data['orderKey'] as string) ?? 'a0',
        (data['origin'] as string) ?? 'device',
        num(data['addedAt']),
        remoteUpdated,
        data['deletedAt'] == null ? null : num(data['deletedAt']),
        (data['deviceId'] as string) ?? '',
      ],
    );
    return;
  }

  if (entity === 'bookmarks') {
    sqlite.runSync(
      `INSERT INTO bookmarks (id, talk_id, position_sec, label, note, created_at, updated_at, deleted_at, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         position_sec=excluded.position_sec, label=excluded.label, note=excluded.note,
         deleted_at=excluded.deleted_at, updated_at=excluded.updated_at
       WHERE excluded.updated_at > bookmarks.updated_at`,
      [
        id,
        (data['talkId'] as string) ?? '',
        num(data['positionSec']),
        (data['label'] as string | null) ?? null,
        (data['note'] as string | null) ?? null,
        num(data['createdAt']),
        remoteUpdated,
        data['deletedAt'] == null ? null : num(data['deletedAt']),
        (data['deviceId'] as string) ?? '',
      ],
    );
    return;
  }

  if (entity === 'queue') {
    if (data['deletedAt']) {
      sqlite.runSync(`DELETE FROM queue WHERE talk_id = ?`, [id]);
      return;
    }
    sqlite.runSync(
      `INSERT INTO queue (talk_id, order_key, added_at) VALUES (?, ?, ?)
       ON CONFLICT(talk_id) DO UPDATE SET order_key=excluded.order_key`,
      [id, (data['orderKey'] as string) ?? 'a0', num(data['addedAt'])],
    );
    return;
  }

  if (entity === 'tags') {
    sqlite.runSync(
      `INSERT INTO tags (id, name, color, kind, origin, updated_at, deleted_at, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, color=excluded.color, deleted_at=excluded.deleted_at,
         updated_at=excluded.updated_at
       WHERE excluded.updated_at > tags.updated_at`,
      [
        id,
        (data['name'] as string) ?? '',
        (data['color'] as string | null) ?? null,
        (data['kind'] as string) ?? 'user',
        (data['origin'] as string) ?? 'device',
        remoteUpdated,
        data['deletedAt'] == null ? null : num(data['deletedAt']),
        (data['deviceId'] as string) ?? '',
      ],
    );
    return;
  }

  if (entity === 'talkTags') {
    const [talkId, tagId] = id.split('__');
    if (!talkId || !tagId) return;
    sqlite.runSync(
      `INSERT INTO talk_tags (talk_id, tag_id, origin, updated_at, deleted_at, device_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(talk_id, tag_id) DO UPDATE SET
         deleted_at=excluded.deleted_at, updated_at=excluded.updated_at
       WHERE excluded.updated_at > talk_tags.updated_at`,
      [
        talkId,
        tagId,
        (data['origin'] as string) ?? 'device',
        remoteUpdated,
        data['deletedAt'] == null ? null : num(data['deletedAt']),
        (data['deviceId'] as string) ?? '',
      ],
    );
  }
}

function applyAll(changes: SyncChange[]): void {
  if (!changes.length) return;
  sqlite.execSync('BEGIN');
  try {
    for (const change of changes) applyChange(change);
    sqlite.execSync('COMMIT');
  } catch (e) {
    sqlite.execSync('ROLLBACK');
    console.warn('[sync] failed to apply remote changes:', e);
  }
}

/** Cold-start catch-up: everything changed since the stored cursor. */
export async function pullOnce(): Promise<void> {
  const backend = getSyncBackend();
  if (!backend || !backend.currentUserId()) return;

  const cursor = Number.parseInt(getMeta(CURSOR_KEY) ?? '0', 10) || 0;
  try {
    const { changes, cursor: next } = await backend.pull(USER_ENTITIES, cursor);
    applyAll(changes);
    setMeta(CURSOR_KEY, String(next));
  } catch (e) {
    console.warn('[sync] pull failed:', e);
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────────

/**
 * Start syncing for the signed-in account. Safe to call repeatedly.
 *
 * §12.2's cadence: flush on background, and every 60 s while foregrounded and dirty.
 * The live listener replaces state.json's polling entirely — that is the thing moving
 * to Firestore actually bought.
 */
export function startSync(): void {
  const backend = getSyncBackend();
  if (!backend || !backend.currentUserId()) return;

  void pullOnce().then(() => void flush());

  if (!listeners) {
    listeners = backend.subscribe(USER_ENTITIES, (changes) => applyAll(changes));
  }
  if (!timer) {
    timer = setInterval(() => void flush(), 60_000);
  }
}

export function stopSync(): void {
  listeners?.();
  listeners = null;
  if (timer) clearInterval(timer);
  timer = null;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function bool(v: unknown): number {
  return v === true || v === 1 ? 1 : 0;
}
