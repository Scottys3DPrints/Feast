/**
 * In-app self-update over the air, no cable.
 *
 * The mechanism, end to end:
 *
 *   1. `publish-update.bat` on the PC builds a signed release APK and writes
 *      `feast-update.json` beside it, then both are uploaded to a GitHub release.
 *   2. The phone fetches that manifest from a URL that always points at the newest
 *      release, and compares `versionCode` against its own.
 *   3. If newer, it downloads the APK to the cache directory, checks the md5, and
 *      hands it to Android's package installer.
 *
 * ── Why this and not expo-updates / EAS Update ──────────────────────────────────
 *
 * EAS Update ships JS and assets only. It cannot deliver a change to a native module,
 * a config plugin, or a new dependency — those need a new APK. Feast is nowhere near
 * native-stable: §4.7 alone requires a custom Expo module for iOS backup exclusion in
 * Phase 3, and Phases 5–6 add more. An update channel that silently cannot deliver
 * half of the changes is worse than no update channel, because the failure looks like
 * "the update did nothing" rather than an error.
 *
 * Shipping whole APKs costs ~40 MB per update instead of ~1 MB. For one person on
 * Wi-Fi that is a fine trade for "every change can actually ship". Once the native
 * surface settles, adding expo-updates *alongside* this would make the common case
 * instant, and the two compose fine.
 *
 * ── On integrity ────────────────────────────────────────────────────────────────
 *
 * The md5 in the manifest detects a truncated or corrupted download. It is NOT the
 * security boundary and must not be treated as one. The real guarantee is Android's:
 * it refuses to install an APK over an existing app unless it is signed with the same
 * key, so a substituted APK cannot install even if it matched the hash. That is also
 * why `feast-release.jks` must never be lost — see plugins/withReleaseSigning.js.
 */
import { Directory, File, Paths } from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

export interface UpdateManifest {
  versionCode: number;
  versionName: string;
  apkUrl: string;
  /** Lowercase hex md5 of the APK. Corruption check only — see the note above. */
  md5?: string;
  notes?: string;
  releasedAt?: string;
  sizeBytes?: number;
}

export type UpdateCheck =
  | { status: 'up-to-date'; currentVersionCode: number }
  | { status: 'available'; currentVersionCode: number; manifest: UpdateManifest }
  | { status: 'unsupported-platform' }
  | { status: 'not-configured' }
  | { status: 'error'; message: string };

export type DownloadProgress = {
  bytesWritten: number;
  totalBytes: number;
};

const manifestUrl = (): string =>
  (Constants.expoConfig?.extra?.['updateManifestUrl'] as string | undefined) ?? '';

/** The running build's versionCode. This is what Android upgrades are keyed on. */
export function currentVersionCode(): number {
  const raw = Application.nativeBuildVersion;
  const parsed = raw == null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function currentVersionName(): string {
  return Application.nativeApplicationVersion ?? '0.0.0';
}

/**
 * Ask the manifest whether there is a newer build.
 *
 * `cache: 'no-store'` matters more than it looks: GitHub serves release assets through
 * a CDN, and a cached manifest would keep reporting the previous version for as long
 * as the edge held it — which reads to the user as "the update button is broken".
 */
export async function checkForUpdate(): Promise<UpdateCheck> {
  if (Platform.OS !== 'android') {
    // iOS has no equivalent path: sideloading an .ipa from inside an app is not
    // something the OS permits. iOS updates go through TestFlight (§21 question 6).
    return { status: 'unsupported-platform' };
  }

  const url = manifestUrl();
  if (!url) return { status: 'not-configured' };

  const current = currentVersionCode();

  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      // A 404 is the normal state before the first release is published, so say that
      // rather than showing a bare status code.
      if (res.status === 404) {
        return {
          status: 'error',
          message: 'No release published yet. Run publish-update.bat on your PC first.',
        };
      }
      return { status: 'error', message: `Update server returned ${res.status}.` };
    }

    const manifest = (await res.json()) as UpdateManifest;
    if (typeof manifest?.versionCode !== 'number' || typeof manifest?.apkUrl !== 'string') {
      return { status: 'error', message: 'The update manifest is malformed.' };
    }

    if (manifest.versionCode <= current) {
      return { status: 'up-to-date', currentVersionCode: current };
    }
    return { status: 'available', currentVersionCode: current, manifest };
  } catch (e) {
    return {
      status: 'error',
      message: e instanceof Error ? e.message : 'Could not reach the update server.',
    };
  }
}

/** Where APKs land. Cache, deliberately — Android may reclaim them and that is fine. */
function apkDirectory(): Directory {
  const dir = new Directory(Paths.cache, 'updates');
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

/**
 * Download the APK and hand it to Android's installer.
 *
 * Resolves once the installer has been launched — not once the install finishes. The
 * app is about to be replaced by the very package being installed, so there is no
 * "after" for this function to observe: Android tears the process down mid-update.
 */
export async function downloadAndInstall(
  manifest: UpdateManifest,
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  const dir = apkDirectory();

  // Named by version so a retry after a failed download cannot pick up a stale file
  // from a different version.
  const dest = new File(dir, `feast-${manifest.versionName}-${manifest.versionCode}.apk`);
  if (dest.exists) dest.delete();

  const task = File.createDownloadTask(manifest.apkUrl, dest, {
    onProgress: ({ bytesWritten, totalBytes }) => {
      onProgress?.({ bytesWritten, totalBytes: totalBytes ?? manifest.sizeBytes ?? 0 });
    },
  });

  // downloadAsync resolves to null if the task was cancelled rather than completed.
  const file = await task.downloadAsync();
  if (!file) throw new Error('The download was cancelled.');

  if (!file.exists || file.size === 0) {
    throw new Error('The download produced no file. Check the connection and try again.');
  }

  // §4.7's Android warning applies here too: a failed download can leave a partial
  // file behind, and a partial APK fails to install with an opaque parser error.
  // Comparing against the manifest turns that into a sentence the user can act on.
  if (manifest.md5) {
    const actual = file.md5?.toLowerCase();
    if (actual && actual !== manifest.md5.toLowerCase()) {
      file.delete();
      throw new Error('The download was corrupted. Nothing was installed — try again.');
    }
  }

  // A `file://` URI would trip Android's FileUriExposedException; the installer needs
  // a content:// URI from a FileProvider, which expo-file-system exposes directly.
  await IntentLauncher.startActivityAsync('android.intent.action.INSTALL_PACKAGE', {
    data: file.contentUri,
    flags:
      1 /* FLAG_GRANT_READ_URI_PERMISSION — without it the installer cannot read the file */,
  });
}

/** Drop any APKs left over from previous updates. Safe to call at any time. */
export function clearDownloadedApks(): void {
  const dir = apkDirectory();
  if (!dir.exists) return;
  for (const entry of dir.list()) {
    if (entry instanceof File && entry.extension === '.apk') entry.delete();
  }
}
