/**
 * The app's single `SyncBackend` instance.
 *
 * Everything above this file talks to the interface from `@feast/sync`, never to
 * Firebase. Swapping backends is changing the constructor call here.
 */
import Constants from 'expo-constants';
import { FirestoreBackend, type FirebaseConfig, type SyncBackend } from '@feast/sync';

function readConfig(): FirebaseConfig | null {
  const extra = Constants.expoConfig?.extra as Record<string, string | undefined> | undefined;
  const cfg: FirebaseConfig = {
    apiKey: extra?.['firebaseApiKey'] ?? '',
    authDomain: extra?.['firebaseAuthDomain'] ?? '',
    projectId: extra?.['firebaseProjectId'] ?? '',
    storageBucket: extra?.['firebaseStorageBucket'] ?? '',
    messagingSenderId: extra?.['firebaseMessagingSenderId'] ?? '',
    appId: extra?.['firebaseAppId'] ?? '',
  };
  // A build with no Firebase config must degrade to "sync is off", not crash on launch.
  // The library still works entirely offline — SQLite is the source of truth for reads
  // (§3.1), so a missing backend costs the user sync, not the app.
  return cfg.apiKey && cfg.projectId ? cfg : null;
}

let cached: SyncBackend | null | undefined;

export function getSyncBackend(): SyncBackend | null {
  if (cached !== undefined) return cached;
  const config = readConfig();
  cached = config ? new FirestoreBackend(config) : null;
  return cached;
}

export function isSyncConfigured(): boolean {
  return getSyncBackend() !== null;
}
