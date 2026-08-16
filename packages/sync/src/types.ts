/**
 * `SyncBackend` — the metadata sync boundary.
 *
 * This is the same insurance policy `StorageProvider` (§7) is for audio, applied to
 * user state. Firestore is the implementation today; the interface exists so that a
 * later move back to a plain document (state.json), or on to Supabase/PowerSync, is one
 * new file rather than a rewrite of every screen.
 *
 * ⚠️ RULE, mirroring §7.2's: **no Firebase type may escape `packages/sync/`.** Nothing
 * above this boundary may import from `firebase/*`, hold a `DocumentReference`, or know
 * that collections are called collections. Everything crosses as plain records keyed by
 * the same string ids the SQLite schema (§6.2) uses.
 *
 * ── Why a sync backend AND SQLite ────────────────────────────────────────────────
 *
 * Firestore has its own offline cache, so it is tempting to let it replace the local
 * database. It cannot:
 *
 *   • §13 requires offline full-text search over titles, speakers and transcripts.
 *     Firestore has no substring or full-text query at all — that is what FTS5 is for.
 *   • §17 budgets 60 fps over 2,000 rows via keyset-paginated queries. Firestore's
 *     query model cannot express most of the library's sorts and filters offline.
 *   • §3.1: "Browsing must work offline, instantly, always." SQLite is a local file;
 *     Firestore's cache is a best-effort mirror of a remote service.
 *
 * ⇒ SQLite stays the query engine and the source of truth for reads. This backend is a
 *   sync bus: it publishes local changes and streams remote ones back into SQLite.
 */

/** Every syncable entity carries these — §12.5's "sync-ready shape". */
export interface SyncMeta {
  /** epoch ms — the LWW clock (§12.4). */
  updatedAt: number;
  /** Soft delete. A tombstone is the only way to express removal across devices. */
  deletedAt?: number | null;
  deviceId: string;
}

/** The entity families this backend carries. Audio never travels through here. */
export type SyncEntity =
  | 'talks'
  | 'speakers'
  | 'series'
  | 'collections'
  | 'collectionMembers'
  | 'tags'
  | 'talkTags'
  | 'listenState'
  | 'bookmarks'
  | 'queue';

/** A single record, already flattened to what SQLite stores. */
export interface SyncRecord extends SyncMeta {
  /** Stable document id. For composite keys, the joined form: `${collectionId}__${talkId}`. */
  id: string;
  [field: string]: unknown;
}

export interface SyncChange {
  entity: SyncEntity;
  id: string;
  /**
   * `null` payload means the record was removed remotely. Note this is distinct from a
   * soft delete: a soft delete arrives as a normal record with `deletedAt` set, which is
   * what §12.4 requires for the removal to propagate to a third device.
   */
  data: SyncRecord | null;
}

export interface SyncBatchItem {
  entity: SyncEntity;
  id: string;
  /** `upsert` merges fields; `delete` writes a tombstone rather than removing. */
  op: 'upsert' | 'delete';
  /**
   * CHANGED FIELDS ONLY — §12.2. Sending the whole record would clobber a concurrent
   * edit from another device on a field this device never touched.
   */
  payload: Record<string, unknown>;
}

export type Unsubscribe = () => void;

export interface SyncBackend {
  readonly id: 'firestore';

  /**
   * Create an account. Resolves to the stable account id.
   *
   * The id is what every document is namespaced under, so it is the thing that makes a
   * second device show the same library rather than an empty one.
   */
  signUp(email: string, password: string): Promise<string>;
  /** Sign in to an existing account. */
  signIn(email: string, password: string): Promise<string>;
  /**
   * Sign in with a Google ID token obtained by the caller.
   *
   * The token is fetched by the app (which owns the OAuth redirect and the browser
   * session) and handed here, rather than this package launching a browser — that keeps
   * every platform concern out of the sync boundary.
   */
  signInWithGoogleIdToken(idToken: string): Promise<string>;
  /** Send a reset email. Resolves even if the address has no account, to avoid
   *  confirming which addresses are registered. */
  resetPassword(email: string): Promise<void>;
  signOut(): Promise<void>;
  /** Current account id, or null when signed out. Never throws. */
  currentUserId(): string | null;
  /** Fires on every auth transition, including the initial restore from disk. */
  onAuthChange(cb: (userId: string | null) => void): Unsubscribe;

  /**
   * Publish local changes. Applied atomically where the backend supports it, so a
   * partially-flushed outbox can never leave one device's state half-written.
   */
  push(items: SyncBatchItem[]): Promise<void>;

  /**
   * Everything changed since `cursor` (epoch ms), for cold start and catch-up.
   * Returns a new cursor to persist in `sync_meta`.
   */
  pull(
    entities: SyncEntity[],
    cursor: number,
  ): Promise<{ changes: SyncChange[]; cursor: number }>;

  /**
   * Live updates while the app is foregrounded — the reason for moving off state.json.
   * The callback fires per batch, not per document.
   */
  subscribe(entities: SyncEntity[], cb: (changes: SyncChange[]) => void): Unsubscribe;
}

/** Thrown for every backend failure, so callers never catch a Firebase error type. */
export class SyncError extends Error {
  constructor(
    readonly code: 'auth' | 'permission' | 'network' | 'quota' | 'unknown',
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}
