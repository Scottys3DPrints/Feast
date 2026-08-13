import { createMMKV } from 'react-native-mmkv';
import { OneDriveProvider, type PathMapStore, type StorageProvider } from '@feast/storage';
import { MsTokenProvider } from '../auth/msAuth';

/**
 * The app's single StorageProvider instance — SPEC §7.
 *
 * Everything above this file addresses content by logical path. Nothing above it may
 * hold a driveItem id (§7.2 rule 1 / acceptance criterion 18), which is why this
 * module exports `StorageProvider` rather than `OneDriveProvider`: the concrete type
 * is not reachable from the app's type graph.
 */

/** Separate MMKV instance so clearing the path map never touches playback positions. */
const pathMapStore = createMMKV({ id: 'feast.pathmap' });

/**
 * §7.1 step 1 — the persisted `path → driveItemId` map. A hit makes streaming one
 * Graph call; a miss makes it one Graph call by a different route. This is latency,
 * not correctness, so a cold or wiped map is always safe.
 */
class MmkvPathMap implements PathMapStore {
  get(path: string): string | undefined {
    return pathMapStore.getString(path) ?? undefined;
  }
  set(path: string, id: string): void {
    pathMapStore.set(path, id);
  }
  delete(path: string): void {
    pathMapStore.remove(path);
  }
  *entries(): Iterable<[string, string]> {
    for (const key of pathMapStore.getAllKeys()) {
      const value = pathMapStore.getString(key);
      if (value) yield [key, value];
    }
  }
}

export const tokenProvider = new MsTokenProvider();

/** Epoch ms until which Graph is gated, or 0. §16: surface throttling, never hide it. */
let throttledUntil = 0;
export function getThrottledUntil(): number {
  return throttledUntil > Date.now() ? throttledUntil : 0;
}

let instance: StorageProvider | null = null;

export function getStorage(): StorageProvider {
  instance ??= new OneDriveProvider(tokenProvider, {
    root: 'Talks',
    pathMap: new MmkvPathMap(),
    onThrottle: ({ retryAfterSec }) => {
      throttledUntil = Date.now() + retryAfterSec * 1000;
    },
  });
  return instance;
}

/** Called on sign-out: the next session's ids belong to a different account. */
export function resetStorage(): void {
  instance = null;
  pathMapStore.clearAll();
}
