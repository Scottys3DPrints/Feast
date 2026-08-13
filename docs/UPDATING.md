# Updating Feast on the phone

Two paths. Use the second one for almost everything.

## Over the air — the button

```
publish-update.bat
```

Then on the phone: **Settings → Updates → Check for updates → Download and install.**

That's the whole loop. No cable, no laptop, no reinstall. The app keeps its database,
so ratings, bookmarks, collections, and listening positions all survive.

Before running it, bump both constants at the top of
[`apps/mobile/app.config.ts`](../apps/mobile/app.config.ts):

```ts
const VERSION_CODE = 2;        // must increase, every single time
const VERSION_NAME = '0.2.0';
```

> ⚠️ **`VERSION_CODE` is the one that matters.** Android compares it — not the
> version name — to decide whether an install is an upgrade, and the update check does
> the same. Ship a build with an unchanged `VERSION_CODE` and the phone will report
> "up to date" while staring straight at the new release. The publish script reads both
> values out of `app.config.ts` so the APK and the manifest can never disagree, but it
> cannot know you meant to bump them.

## Over a cable

```
update.bat
```

Builds and installs over USB with `adb install -r`. Same in-place upgrade, same data
kept. Use it when the phone is plugged in anyway, or to get a native change onto the
phone without publishing a release.

---

## How it works

```
publish-update.bat                       phone
  │                                        │
  ├─ typecheck (the guard)                 │
  ├─ build signed release APK              │
  ├─ write dist/feast-update.json          │
  └─ gh release create v<version> ────────▶│  Settings → Updates
       ├─ feast-<version>.apk              │    ├─ GET .../releases/latest/download/
       └─ feast-update.json                │    │      feast-update.json
                                           │    ├─ versionCode > mine?
                                           │    ├─ download APK, check md5
                                           │    └─ hand to Android's installer
```

The app polls `https://github.com/<owner>/Feast/releases/latest/download/feast-update.json`.
GitHub resolves `releases/latest` to the newest release, so that URL is correct forever
and a phone built today will still find a release published in two years.

## Why whole APKs, and not expo-updates

Expo's own OTA system (EAS Update) ships JavaScript and assets only. It cannot deliver
a change to a native module, a config plugin, or a new dependency — those need a new
APK regardless.

Feast is nowhere near native-stable. Spec §4.7 alone requires a custom Expo module for
iOS backup exclusion in Phase 3, Phase 5 adds the transcode/rendition work, and Phase 6
adds Android Auto. An update channel that silently cannot deliver half of the changes
is worse than none, because the failure mode is "the update did nothing" rather than a
visible error.

The cost is ~40 MB per update instead of ~1 MB. For one person on Wi-Fi that is a fine
trade for *every* change being shippable. Once the native surface settles, adding
expo-updates alongside this would make the common case instant; the two compose fine.

## Integrity, honestly

The manifest carries an md5. That catches a truncated or corrupted download — which
matters, because a partial APK fails to install with an opaque parser error rather than
a useful one.

**It is not the security boundary.** The real guarantee is Android's: it refuses to
install an APK over an existing app unless it is signed with the same key. A
substituted APK cannot install even if it matched the hash.

Which is why the keystore matters more than anything else in this directory.

## ⚠️ Back up the signing key

```
apps/mobile/feast-release.jks
apps/mobile/keystore.properties
```

Both are gitignored — `keystore.properties` contains the password in plain text and the
repo is public. Copy them somewhere private and durable (a password manager, an
encrypted backup) **now**, not later.

Lose them and no future build can ever update the installed app. Android identifies an
app by package name *plus* signing key; a build signed with a new key installs only
after uninstalling the old one, and uninstalling deletes the database. Every rating,
bookmark, collection, and listening position goes with it.

There is no recovery path for this. There is only the backup.

## Troubleshooting

**"No release published yet."** Expected before the first `publish-update.bat` run.

**Phone says up to date, but you just published.** `VERSION_CODE` wasn't bumped. Bump
it and publish again.

**`INSTALL_FAILED_UPDATE_INCOMPATIBLE`.** The APK was signed with a different key than
the installed app. Do **not** uninstall to work around it — that erases the library
state. Find the original `feast-release.jks`.

**Android blocks the install.** The first time, it asks permission to install unknown
apps for Feast. Allow it once; it persists.

**iOS.** None of this applies — sideloading an `.ipa` from inside an app isn't
something the OS permits. iOS updates go through TestFlight (spec §21, question 6).
