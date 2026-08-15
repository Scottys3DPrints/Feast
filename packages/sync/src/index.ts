/**
 * `@feast/sync` — the metadata sync boundary.
 *
 * Import `SyncBackend` and the record types from here. Do NOT import from
 * `firebase/*` anywhere outside this package — see the rule in ./types.ts.
 */
export * from './types';
export { FirestoreBackend, compositeId } from './firestore/FirestoreBackend';
export type { FirebaseConfig } from './firestore/FirestoreBackend';
