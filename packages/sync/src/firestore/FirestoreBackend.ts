/**
 * Firestore implementation of `SyncBackend`.
 *
 * ⚠️ THIS IS THE ONLY FILE IN THE REPO THAT MAY IMPORT FROM `firebase/*`.
 * See the rule in ../types.ts. Breaking it is the sync-layer equivalent of leaking a
 * driveItem id out of packages/storage, and it costs the same thing: the ability to
 * change backends without touching the app.
 *
 * ── Data layout ─────────────────────────────────────────────────────────────────
 *
 *   users/{uid}/talks/{talkId}
 *   users/{uid}/speakers/{speakerId}
 *   users/{uid}/collections/{collectionId}
 *   users/{uid}/collectionMembers/{collectionId__talkId}
 *   users/{uid}/listenState/{talkId}
 *   …and so on, one subcollection per SyncEntity.
 *
 * Everything is namespaced under the account so a security rule of "you may read and
 * write your own subtree, and nothing else" covers the whole model in four lines.
 *
 * ── On document counts and cost ──────────────────────────────────────────────────
 *
 * ~1,875 talks is ~1,875 documents. A cold sync is therefore ~1,875 reads, against a
 * free tier of 50,000/day — and it happens once per device, because `pull()` is
 * cursor-based and every later sync reads only what changed. Writes are the same story:
 * the initial import is a one-off, and steady-state traffic is a handful of documents
 * when a rating or a position changes.
 *
 * The reason this stays cheap is that AUDIO NEVER COMES NEAR FIRESTORE. Files stay in
 * OneDrive behind `StorageProvider`; Firebase Storage would cost ~$0.12/GB egress,
 * which on a 24.5 GB library that is actually listened to is the one way to make this
 * architecture expensive.
 */
import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import {
  createUserWithEmailAndPassword,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithCredential,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  type Auth,
} from 'firebase/auth';
import {
  collection,
  doc,
  getDocs,
  getFirestore,
  onSnapshot,
  query,
  where,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import type {
  SyncBackend,
  SyncBatchItem,
  SyncChange,
  SyncEntity,
  SyncRecord,
  Unsubscribe,
} from '../types';
import { SyncError } from '../types';

export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}

/** Firestore forbids '/' in ids; composite keys are joined with a separator instead. */
const KEY_SEP = '__';

export function compositeId(...parts: string[]): string {
  return parts.join(KEY_SEP);
}

/**
 * Firestore rejects `undefined` field values outright, and the domain types use
 * optional properties everywhere (§6.1). Stripping is cheaper than making every caller
 * remember, and turning `undefined` into `null` would corrupt the LWW merge — a null
 * means "explicitly cleared", which is not what a missing optional means.
 */
function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function classify(e: unknown): SyncError {
  const code = (e as { code?: string } | null)?.code ?? '';
  const message = e instanceof Error ? e.message : String(e);
  if (code.includes('permission-denied')) return new SyncError('permission', message, e);
  if (code.includes('unauthenticated')) return new SyncError('auth', message, e);
  if (code.includes('unavailable') || code.includes('network'))
    return new SyncError('network', message, e);
  if (code.includes('resource-exhausted')) return new SyncError('quota', message, e);
  return new SyncError('unknown', message, e);
}

export class FirestoreBackend implements SyncBackend {
  readonly id = 'firestore' as const;

  private readonly app: FirebaseApp;
  private readonly auth: Auth;
  private readonly db: Firestore;

  constructor(config: FirebaseConfig) {
    // getApps() guard: Fast Refresh re-runs module bodies, and initializeApp throws on
    // a duplicate app name.
    this.app = getApps().length ? getApps()[0]! : initializeApp(config);
    this.auth = getAuth(this.app);
    this.db = getFirestore(this.app);
  }

  // ─── Auth ─────────────────────────────────────────────────────────────────────

  /**
   * Real accounts, email + password.
   *
   * Anonymous auth was the obvious shortcut and is deliberately not used: an anonymous
   * uid is minted per install, so a second device signs in as a *different* user and
   * sees an empty library — which defeats the only reason to run a sync backend at all.
   *
   * Firebase persists the session to disk and refreshes it silently, so this is asked
   * once per device and then never again.
   */
  async signUp(email: string, password: string): Promise<string> {
    try {
      const cred = await createUserWithEmailAndPassword(this.auth, email.trim(), password);
      return cred.user.uid;
    } catch (e) {
      throw classify(e);
    }
  }

  async signIn(email: string, password: string): Promise<string> {
    try {
      const cred = await signInWithEmailAndPassword(this.auth, email.trim(), password);
      return cred.user.uid;
    } catch (e) {
      throw classify(e);
    }
  }

  /**
   * Exchange a Google ID token for a Firebase session.
   *
   * If this account's email already exists as an email+password account, Firebase links
   * the two by default rather than erroring, so a user who signed up with a password
   * and later taps "Continue with Google" keeps the same uid — and therefore the same
   * library, rather than silently starting an empty second one.
   */
  async signInWithGoogleIdToken(idToken: string): Promise<string> {
    try {
      const credential = GoogleAuthProvider.credential(idToken);
      const cred = await signInWithCredential(this.auth, credential);
      return cred.user.uid;
    } catch (e) {
      throw classify(e);
    }
  }

  async resetPassword(email: string): Promise<void> {
    try {
      await sendPasswordResetEmail(this.auth, email.trim());
    } catch (e) {
      const err = classify(e);
      // Deliberately swallowed: Firebase reports `auth/user-not-found` here, and
      // surfacing it would turn this screen into a way to test which addresses have
      // accounts. The user sees the same "check your email" either way.
      if (err.message.includes('user-not-found')) return;
      throw err;
    }
  }

  async signOut(): Promise<void> {
    try {
      await fbSignOut(this.auth);
    } catch (e) {
      throw classify(e);
    }
  }

  currentUserId(): string | null {
    return this.auth.currentUser?.uid ?? null;
  }

  onAuthChange(cb: (userId: string | null) => void): Unsubscribe {
    return onAuthStateChanged(this.auth, (user) => cb(user?.uid ?? null));
  }

  // ─── Paths ────────────────────────────────────────────────────────────────────

  private requireUid(): string {
    const uid = this.currentUserId();
    if (!uid) throw new SyncError('auth', 'Not signed in.');
    return uid;
  }

  private col(entity: SyncEntity) {
    return collection(this.db, 'users', this.requireUid(), entity);
  }

  // ─── Push ─────────────────────────────────────────────────────────────────────

  /**
   * Firestore caps a batch at 500 writes, so the outbox is chunked. Each chunk commits
   * atomically; chunks do not commit atomically with each other, which is acceptable
   * because every record carries its own `updatedAt` and the merge (§12.4) is
   * order-independent.
   */
  async push(items: SyncBatchItem[]): Promise<void> {
    if (items.length === 0) return;
    const uid = this.requireUid();

    try {
      for (let i = 0; i < items.length; i += 450) {
        const chunk = items.slice(i, i + 450);
        const batch = writeBatch(this.db);

        for (const item of chunk) {
          const ref = doc(this.db, 'users', uid, item.entity, item.id);
          if (item.op === 'delete') {
            // A tombstone, NOT a Firestore delete. §12.4: "removals need an explicit
            // tombstone, never an implicit absence" — a hard delete is invisible to a
            // device that was offline when it happened, so the row silently returns.
            batch.set(
              ref,
              stripUndefined({ ...item.payload, deletedAt: Date.now(), updatedAt: Date.now() }),
              { merge: true },
            );
          } else {
            batch.set(ref, stripUndefined(item.payload), { merge: true });
          }
        }

        await batch.commit();
      }
    } catch (e) {
      throw classify(e);
    }
  }

  // ─── Pull ─────────────────────────────────────────────────────────────────────

  async pull(
    entities: SyncEntity[],
    cursor: number,
  ): Promise<{ changes: SyncChange[]; cursor: number }> {
    const changes: SyncChange[] = [];
    let newest = cursor;

    try {
      for (const entity of entities) {
        const snap = await getDocs(query(this.col(entity), where('updatedAt', '>', cursor)));
        for (const d of snap.docs) {
          const data = { id: d.id, ...d.data() } as SyncRecord;
          if (typeof data.updatedAt === 'number' && data.updatedAt > newest) {
            newest = data.updatedAt;
          }
          changes.push({ entity, id: d.id, data });
        }
      }
    } catch (e) {
      throw classify(e);
    }

    return { changes, cursor: newest };
  }

  // ─── Subscribe ────────────────────────────────────────────────────────────────

  subscribe(entities: SyncEntity[], cb: (changes: SyncChange[]) => void): Unsubscribe {
    const unsubs: Unsubscribe[] = [];

    for (const entity of entities) {
      const unsub = onSnapshot(
        this.col(entity),
        (snap) => {
          // `docChanges()` rather than the full snapshot: the whole point of a listener
          // is to pay for what moved, not to re-read 1,875 talks on every keystroke
          // somewhere else.
          const batch: SyncChange[] = snap.docChanges().map((c) => ({
            entity,
            id: c.doc.id,
            data:
              c.type === 'removed' ? null : ({ id: c.doc.id, ...c.doc.data() } as SyncRecord),
          }));
          if (batch.length) cb(batch);
        },
        // A listener error must not throw into an unhandled rejection and kill the
        // stream silently; §16 requires the failure be visible rather than mysterious.
        (err) => {
          console.warn(`[sync] listener failed for ${entity}:`, classify(err).message);
        },
      );
      unsubs.push(unsub);
    }

    return () => unsubs.forEach((u) => u());
  }
}
