import type { ExpoConfig } from 'expo/config';

/**
 * Expo config — SPEC §4.1, §4.3, §4.6, §4.7.
 *
 * Two plugin settings here are load-bearing rather than cosmetic:
 *
 *   • `expo-sqlite` with `enableFTS` — §4.6. Without it there is no FTS5 and §13's
 *     offline transcript search cannot exist. Requires a dev build; Expo Go will not
 *     do. This is the reason `expo start --dev-client` is the start script.
 *   • `expo-audio` — its config plugin appends "audio" to iOS `UIBackgroundModes` and
 *     registers the Android `MediaSessionService` with `foregroundServiceType=
 *     "mediaPlayback"` plus the FGS permissions Android 14 requires (§4.3). It does
 *     this automatically while `enableBackgroundPlayback` stays true (the default),
 *     so the correct action is to leave it alone.
 *
 * `targetSdkVersion: 36` is a deadline, not a preference: Google Play requires it for
 * new apps from 31 August 2026 (§4.3).
 */

/**
 * ⚠️ REQUIRED BEFORE FIRST RUN — see README §"Microsoft app registration".
 * Register a free app in Entra, choose "Mobile and desktop applications" for the
 * redirect (NOT "Single-page application" — an spa-typed redirect caps refresh
 * tokens at 24 hours, §4.4), and put the client id here or in EXPO_PUBLIC_MS_CLIENT_ID.
 */
const MS_CLIENT_ID = process.env.EXPO_PUBLIC_MS_CLIENT_ID ?? '';

/**
 * Where the phone looks for a new build (see `docs/UPDATING.md`).
 *
 * GitHub resolves `releases/latest/download/<asset>` to the newest release's asset, so
 * this URL never changes no matter how many versions ship. That is what lets the app be
 * built once with a hardcoded default and still find every future update.
 */
const UPDATE_MANIFEST_URL =
  process.env.EXPO_PUBLIC_UPDATE_MANIFEST_URL ??
  'https://github.com/Scottys3DPrints/Feast/releases/latest/download/feast-update.json';

/**
 * ⚠️ BUMP THIS ON EVERY PUBLISHED BUILD. Android compares versionCode, not versionName,
 * to decide whether an install is an upgrade — and the update check does the same, so a
 * build that forgets to bump it is invisible to phones already running the app.
 * `publish-update.bat` reads it straight out of here so the two can never disagree.
 */
const VERSION_CODE = 1;
const VERSION_NAME = '0.1.0';

const config: ExpoConfig = {
  name: 'Feast',
  slug: 'feast',
  version: VERSION_NAME,
  orientation: 'portrait',
  scheme: 'feast',
  userInterfaceStyle: 'automatic',
  icon: './assets/icon.png',
  // No `newArchEnabled`: §4.1 says the New Architecture is mandatory on SDK 55+ and
  // cannot be disabled, and SDK 57 has duly removed the key from the config type.

  // Splash is configured through the `expo-splash-screen` plugin on SDK 57; the
  // top-level `splash` key no longer exists. Dark by default, per §14.

  ios: {
    supportsTablet: true,
    bundleIdentifier: 'dev.feast.app',
    infoPlist: {
      // Belt and braces: the expo-audio plugin adds this, but a stray prebuild that
      // drops it turns into "audio stops when the screen locks", which is miserable
      // to diagnose from the symptom.
      UIBackgroundModes: ['audio'],
    },
  },

  android: {
    package: 'dev.feast.app',
    versionCode: VERSION_CODE,
    // No `edgeToEdgeEnabled` flag: on SDK 57 / RN 0.86 edge-to-edge is always on and
    // the opt-in was removed from the config type. §4.8's requirement is satisfied by
    // the platform, not by a setting.
    adaptiveIcon: {
      // Foreground is transparent with the mark inside Android's ~66% safe zone —
      // adaptive icons are masked to whatever shape the OEM picks and can lose the
      // outer third, so a full-bleed foreground would have its edges cropped away.
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#0D0F14',
    },
    permissions: [
      // Lets the app hand a downloaded APK to Android's package installer, which is
      // how the in-app update button works without a cable. Android still shows its
      // own confirmation screen and still refuses any APK not signed with the same
      // key — this permission only grants the right to *ask*.
      'android.permission.REQUEST_INSTALL_PACKAGES',
    ],
  },

  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-web-browser',
    ['expo-sqlite', { enableFTS: true }],
    [
      'expo-audio',
      {
        microphonePermission: false,
      },
    ],
    [
      'expo-build-properties',
      {
        android: {
          compileSdkVersion: 36,
          targetSdkVersion: 36,
          minSdkVersion: 24,
        },
        ios: {
          // SDK 57's minimum. expo-build-properties rejects anything lower.
          deploymentTarget: '16.4',
        },
      },
    ],
    './plugins/withReleaseSigning',
    './plugins/withNdkVersion',
  ],

  experiments: {
    typedRoutes: true,
  },

  extra: {
    msClientId: MS_CLIENT_ID,
    updateManifestUrl: UPDATE_MANIFEST_URL,

    // Firebase — metadata sync only. Audio never touches Firebase; it stays in
    // OneDrive behind StorageProvider, because Storage egress (~$0.12/GB) against a
    // 24.5 GB library that is actually listened to is the one way to make this
    // architecture expensive.
    //
    // These are not secrets. A Firebase web config is embedded in every client that
    // ships; access is controlled by the Firestore rules (firestore.rules), which scope
    // every document to users/{uid}.
    firebaseApiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY ?? '',
    firebaseAuthDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN ?? '',
    firebaseProjectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ?? '',
    firebaseStorageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET ?? '',
    firebaseMessagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? '',
    firebaseAppId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID ?? '',

    // Google sign-in needs BOTH: the Android id identifies the app (verified against
    // the signing certificate, hence the SHA-1 registered in Firebase), the Web id is
    // the audience the ID token is minted for and the one Firebase validates.
    googleWebClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '',
    googleAndroidClientId: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID ?? '',
  },
};

export default config;
