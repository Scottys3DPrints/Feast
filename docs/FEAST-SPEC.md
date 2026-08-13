# Feast — Build Specification

**A personal gospel-audio library: cloud-resident, pocket-cached, infinitely expandable.**

> Working name: **Feast** (2 Nephi 32:3 — *"feast upon the words of Christ"*). Rename freely; the name appears only in `app.json`, the design tokens, and the splash.

---

## 0. How to use this document

This is a complete, self-contained build brief for Claude Code. Read it top to bottom before writing any code.

- **§1–3** — what we're building and why it's shaped this way. Read for intent.
- **§4–8** — architecture, data model, storage. These are binding contracts; do not improvise here.
- **§9–13** — the three components in detail.
- **§14–17** — UI/UX. Screen-by-screen, with the design system.
- **§18–21** — build phases, acceptance criteria, testing, risks.

**Non-negotiable rules for the implementer:**

1. Every fact in §4 (Verified Technical Findings) was researched and confirmed in August 2026. Do not substitute training-data assumptions. If something in there is wrong at build time, verify before changing.
2. `StorageProvider` (§7) is the single most important interface in the codebase. Nothing outside `packages/storage/` may import a Microsoft Graph type, ever.
3. This is a **personal-use, single-user** app for one person's own library. It is not distributed, not multi-user, not commercial. Several design decisions (§20) depend on that staying true.
4. Ship phase by phase (§18). Do not build phase 4 before phase 1 works end to end on a real device with real files.

---

## 1. The problem, stated precisely

The user has an existing gospel audio archive on OneDrive:

| Metric | Value |
|---|---|
| Audio files | **1,884** (`.mp3` 1,875, `.m4a` 8, `.wma` 1) — from a listing capped at 2,000 entries, so treat as a floor |
| PDFs | 11 (plus a separate Books folder) |
| Total size | **24.5 GB** |
| Folders | 101 |
| Largest single file | 219.8 MB (`Elder Holland.m4a`) |
| Typical talk | 5–30 MB; typical Education Week lecture 130–150 MB |
| Expected talk count after dedup | ~1,875 (files minus known duplicates) |

⚠️ **Use these numbers consistently.** Everywhere this document says "~1,900 talks" it means the post-dedup entity count, which will be *slightly fewer* than the file count. Do not hardcode any of them in the UI — compute at runtime from the catalog.

⚠️ **The single `.wma` file plays on neither iOS nor Android.** `feast doctor` must flag it and `feast transcode` must be able to convert it to `.m4a`.

Organized as:

```
Talks/
├── By Speaker/
│   ├── Prophets/        08 George Albert Smith … 17 Russell M. Nelson   (numeric = succession order)
│   ├── Apostles/        Bruce R. McConkie, Neal A. Maxwell, …
│   ├── Others/          Hugh Nibley, John Bytheway, Hank Smith, Brad Wilcox, Tad R. Callister, …
│   └── _Listened To/    Eyring, Holland, Nelson, Monson
├── Lectures/            17 Points of the True Church, Dead Sea Scrolls, Understanding Islam, …
├── My List/
│   ├── _Greatest of All      (130 files)
│   ├── _Second Greatest      (39 files)
│   ├── _To be Seen           (Nibley lecture folders — a want-to-listen queue)
│   └── _Redownload           (10 files — known broken/incomplete)
└── PDF Talks/           incl. "Dope PDF Talks"
```

### Four pain points this app must actually solve

**P1 — The library doesn't fit on a phone.** 24.5 GB today, growing without bound. Any design that assumes "sync the library to the device" is dead on arrival.

**P2 — A talk can only live in one folder, so it's duplicated.** Verified example: `Education Week 1998 John Bytheway - Gospel Values for Youth.mp3` (134.7 MB) exists in *both* `By Speaker/Others/John Bytheway/` and `My List/_Greatest of All/`. The same is true for at least four other large files. The filesystem forces a choice between "file by speaker" and "file by how much I loved it," so the user pays for both in gigabytes.

**P3 — Listening state lives in folder names.** `_Listened To/`, `_To be Seen/`, `_Greatest of All/`, `_Redownload/` are a hand-rolled database implemented in `mv` commands. It works, but it's manual, it's lossy (you lose the speaker grouping when you move a file), and it can't express two things at once.

**P4 — Acquiring new talks is manual.** Finding, downloading, renaming, and filing a General Conference session or a BYU devotional is entirely by hand.

### The one-sentence concept

> **Feast turns the OneDrive archive into a streaming catalog: the phone holds a few megabytes of metadata describing everything, streams or caches audio on demand, and lets one talk belong to as many collections as it deserves — while a desktop companion mass-fetches new talks straight into the archive.**

---

## 2. The "not on my device" architecture — *Cloud Library, Pocket Cache*

This is the core answer to the user's central question. Name it in the UI; it's a feature, not plumbing.

### Four residency tiers

```
┌──────────────────────────────────────────────────────────────────────┐
│ TIER 0 — CATALOG (always on device, always offline-available)        │
│ Every talk's title, speaker, duration, tags, collections, artwork    │
│ ref, and — where one exists — full transcript text. SQLite.          │
│ ~1,900 talks ≈ 2 MB metadata; transcripts add ~13 KB each for the    │
│ subset that has one (§9.8). Budget ≤ 40 MB of library data total.    │
│ ⇒ Browse and full-text-search 24.5 GB of library on a plane.         │
├──────────────────────────────────────────────────────────────────────┤
│ TIER 1 — STREAM (0 bytes stored)                                     │
│ Tap play → resolve a fresh signed URL → HTTP Range stream.           │
│ Default behavior on cellular for anything not already cached.        │
├──────────────────────────────────────────────────────────────────────┤
│ TIER 2 — AUTO-CACHE (LRU, user-set budget, default 2 GB)             │
│ Anything streamed is written to disk as it plays. Replays are        │
│ offline and instant. Evicted least-recently-played-first when the    │
│ budget is exceeded. The user never manages this.                     │
├──────────────────────────────────────────────────────────────────────┤
│ TIER 3 — PINNED (never evicted, user-controlled)                     │
│ Pin a talk, a speaker, or an entire collection. "Pin _Greatest of    │
│ All" = 130 talks guaranteed offline for the road trip.               │
│ Shown with an exact size figure before you commit.                   │
└──────────────────────────────────────────────────────────────────────┘
```

### Supporting mechanics

- **Smart preload.** While a talk plays, the next 2 items in the queue are fetched in the background — but only on Wi-Fi, and only if they aren't already cached. Kills the gap between tracks.
- **Wi-Fi-only downloads** (default on). Cellular streaming stays allowed and is separately toggleable.
- **The Storage screen is a first-class screen, not a settings row.** A stacked bar (Pinned / Auto-cached / Free), a per-item list sorted by size, swipe-to-evict, and one "Free up space" button. The user must always be able to answer "what is on my phone right now and why" in two taps.
- **Eviction never loses anything.** Evicting is always safe — the talk is still in the catalog, still searchable, still playable over the network. The UI should say so, once, the first time.

### Optional but strongly recommended: the Stream Rendition

Speech at 128 kbps stereo is wasteful. A desktop-side transcode pass produces a second, compact rendition of each talk.

⚠️ **Codec choice is constrained: use HE-AAC v2 in `.m4a`, not Opus.** Opus in an Ogg container **is not decodable by iOS AVFoundation**, and `expo-audio` wraps AVPlayer on iOS — so an Opus `streamPath` would silently fail on half the target platforms. HE-AAC v2 decodes natively on both.

```bash
ffmpeg -i in.mp3 -c:a aac -profile:a aac_he_v2 -b:a 32k -ac 1 -movflags +faststart out.m4a
# libfdk_aac gives better quality at this bitrate where the build has it:
# ffmpeg -i in.mp3 -c:a libfdk_aac -profile:a aac_he_v2 -b:a 32k -ac 1 out.m4a
```

**Honest arithmetic** (the earlier draft of this spec overstated the saving by ~1.7×):

| | Archive rendition | Stream rendition |
|---|---|---|
| Codec | original (untouched) | HE-AAC v2, 32 kbps mono, `.m4a` |
| Purpose | preservation | playback |
| Bytes per audio-hour | ~57 MB @128k | **~14.1 MB** |
| 24.5 GB library (≈436 audio-hours) | 24.5 GB | **≈ 6.1 GB** |
| 130 MB lecture (2.26 h) | 130 MB | **≈ 32 MB** |
| At 24 kbps instead | — | ≈ 4.6 GB |

⚠️ Much of the older archive is already 64 kbps, meaning *more* hours per GB — the real output could reach ~8 GB. **Measure the actual total audio duration during `feast import` and report the projected transcode size before running it.** Do not print an estimate derived from byte count alone.

Effect: cellular streaming costs ~1/4 as much, cache budgets go 4× further, and a "pin an entire speaker" button becomes realistic. The archive originals are never modified or deleted.

Implement as an opt-in flag on the desktop ingest tool (`--transcode`). The app prefers `streamPath` when present and falls back to `archivePath`. This is **Phase 5**, not Phase 1 — but the data model must carry both paths from day one.

---

## 3. Product principles

1. **The catalog is never wrong about what exists.** Browsing must work offline, instantly, always. Network problems degrade playback, never navigation.
2. **One talk, many homes.** A talk is an entity with tags and collection memberships — never a file in exactly one folder. This is the fix for P2 and P3.
3. **Never surprise the user with storage.** Every action that consumes disk states the number first.
4. **Respect the existing organization.** The import must reproduce the user's folder taxonomy faithfully enough that day one feels like *his* library, not a generic podcast app.
5. **Reverent, not precious.** Quiet, legible, dark-first. It's used while driving, folding laundry, and falling asleep. Big targets, high contrast, no cleverness.
6. **Offline is the default assumption, not the error case.**

---

## 4. Verified technical findings (August 2026)

Researched and confirmed. **Trust this section over your training data.** ✅ = confirmed from primary docs. 🟡 = community-reported. ⚪ = inference.

### 4.1 Platform baseline

| | Version | Note |
|---|---|---|
| Expo SDK | **57** (`expo@57.0.12`) | unified versioning: `expo-audio@57.x`, `expo-sqlite@57.x` |
| React Native | **0.86.2** | pinned by SDK 57 |
| React | 19.2.3 | |

✅ **New Architecture is mandatory and cannot be disabled** (SDK 55+; RN 0.82+ ignores `newArchEnabled=false`). Every library choice below is New-Arch-compatible.

### 4.2 Audio playback — use `expo-audio`, not react-native-track-player

⚠️ **This is the single most commonly-wrong assumption. Read it.**

- `react-native-track-player` v4 (Apache-2.0) is **frozen and no longer maintained** — last release 4.1.2, Aug 2025. No official New Architecture support ([issue #2443](https://github.com/doublesymmetry/react-native-track-player/issues/2443) still open).
- v5 shipped as **`@rntp/player`, a commercial product** — €99/mo or €999/yr for commercial use. No Expo config plugin exists. No CarPlay documentation.
- ⇒ **Use `expo-audio@57.x`.** First-party, New-Arch-native, zero config-plugin work.

**expo-audio capabilities and limits** (verified from shipped typings):

```ts
// Available
useAudioPlayer, useAudioPlayerStatus, useAudioPlaylist, createAudioPlayer,
setAudioModeAsync, preload/clearPreloadedSource
player.play() / pause() / replace(source) / seekTo(sec) / setPlaybackRate(rate, quality)
player.setActiveForLockScreen(active, metadata?, options?)
player.updateLockScreenMetadata(metadata)
AudioSource = { uri, headers?: Record<string,string> }   // ← headers are first-class
AudioLockScreenOptions = { showSeekForward?, showSeekBackward?, isLiveStream? }
```

Three limits that shape the design:

1. **No remote-command events reach JS.** `AudioEvents` is exactly `{ playbackStatusUpdate, audioSampleUpdate }`. There is no `RemoteNext`/`RemoteSeek` listener. You get the native lock-screen widget's behavior and cannot intercept it.
2. **`AudioPlaylist` has no lock-screen API** — only `AudioPlayer` does. ⇒ **Use a single `AudioPlayer` and manage the queue yourself in JS**, calling `setActiveForLockScreen` / `updateLockScreenMetadata` on every track change. Do not use `useAudioPlaylist`.
3. **No persistent disk cache.** `downloadFirst: true` uses tmp and "the system will purge the file at its discretion." Not an offline story. We build the cache ourselves (§11.3).

✅ Android caveat from the docs: *"you have to enable the lock screen controls with `setActiveForLockScreen` for sustained background playback. Otherwise, the audio will stop after approximately 3 minutes."*

Wrap all of this in a `PlayerService` (§11.1) so `@rntp/player` remains a one-file swap if Android Auto/CarPlay ever becomes a requirement.

### 4.3 Background audio configuration

✅ The `expo-audio` config plugin does this automatically when `enableBackgroundPlayback: true` (the default):
- **iOS:** appends `"audio"` to `UIBackgroundModes`.
- **Android:** adds `MODIFY_AUDIO_SETTINGS`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, and registers `expo.modules.audio.service.AudioControlsService` as a `MediaSessionService` with `foregroundServiceType="mediaPlayback"`.

Required runtime call, once at app start:

```ts
await setAudioModeAsync({
  playsInSilentMode: true,       // iOS ringer switch off
  shouldPlayInBackground: true,
  interruptionMode: 'doNotMix',  // REQUIRED for lock-screen controls to bind
});
```

✅ Android 14 (API 34) requires the FGS type + matching permission. ✅ Google Play requires **targetSdk 36** for new apps from 31 Aug 2026 — set via `expo-build-properties`.

### 4.4 OneDrive / Microsoft Graph

**Auth** ✅
- OAuth2 auth-code + **PKCE (S256)** via system browser. No client secret. There is no official MSAL for React Native — use **`expo-auth-session`** + `expo-secure-store`.
- Endpoints: `https://login.microsoftonline.com/consumers/oauth2/v2.0/{authorize,token}` — use `consumers` for personal accounts.
- Scopes: **`Files.ReadWrite offline_access openid profile`**, plus **`Files.ReadWrite.AppFolder`**.
  ⚠️ `Files.Read.All` / `Files.ReadWrite.All` are **rejected for consumer accounts**. `Files.ReadWrite` already covers the whole personal drive.
- ⚠️ **Register the redirect URI under "Mobile and desktop applications", NOT "Single-page application".** An `spa`-typed redirect caps refresh tokens at **24 hours**.
- Access token: 60–90 min (randomized, ~75 avg). Refresh token: **90 days, rolling** — refresh at least once per 90 days and the user never logs in again. App registration in Entra is free.

**Enumeration** ✅
- **Use `delta`, not recursive `children` walks.** `GET /me/drive/root:/<path>:/delta` with no token returns a full recursive enumeration, paged via `@odata.nextLink`, terminating with `@odata.deltaLink`. It is documented as *"the only guaranteed way to retrieve all items in a hierarchy if writes occur during enumeration."*
- Default page size 200; use `$top=999` and `$select` to cut round trips and payload.
- ⚠️ **`parentReference.path` is omitted in delta responses.** Track by `id` and reconstruct the tree from `parentReference.id`.
- ⚠️ Same item may appear multiple times in one response — **use the last occurrence**.
- Expired token → `HTTP 410 Gone` + a `Location` header with a fresh delta URL. Handle it.
- 🟡 Consumer quirks: `childCount` reports 0 on all folders; `Prefer: deltaExcludeParent` is ignored. Filter the root yourself.
- ⚪ ~2,000 files ≈ 3 pages at `$top=999` ≈ 3–10 s cold sync. Latency-bound (serial `nextLink`), not bandwidth-bound.

**Streaming** ✅ — *the critical finding*
- `GET /me/drive/items/{id}/content` → `302` to a pre-authenticated URL; same value as the `@microsoft.graph.downloadUrl` property.
- ✅ **HTTP Range requests are supported on the pre-signed URL.** Documented verbatim: *"To download a partial range of bytes from the file, your app can use the `Range` header… You must append the `Range` header to the actual `@microsoft.graph.downloadUrl` URL and not to the request for `/content`."* Returns `206 Partial Content`. **Seeking works, and ExoPlayer/AVPlayer consume the URL natively.**
- ✅ **No `Authorization` header required** on the download URL — and you must not send one.
  ⚠️ Many HTTP clients auto-follow the 302 *and forward `Authorization`* to `*.files.1drv.com`, a different origin, which rejects it and leaks your Graph token to a CDN host. **Fetch metadata with `$select=id,@microsoft.graph.downloadUrl` and hand the bare URL to the player. Never point the player at `/content`.**
- ⚠️ **Expiry is undocumented and the docs contradict themselves.** driveItem resource page: *"invalidated after… (1 hour)."* get-content page: *"might expire within minutes."* [Issue #884](https://github.com/OneDrive/onedrive-api-docs/issues/884) asks for clarification and has never been answered. 🟡 Practitioners consistently observe ~1 hour.
  ⇒ **Design for expiry-at-any-moment. Never persist a downloadUrl. Re-resolve immediately before playback. On a 403 mid-stream, re-resolve and restore position via `replace()` + `seekTo()` — see §11.4 for the exact sequence.**
  ⚠️ Note: you cannot issue a `Range` header *through* `expo-audio`. Range applies to the raw HTTP downloads in the cache layer (§11.3), where a resumed download **does** use `Range: bytes=<bytesWritten>-`. Do not confuse the two paths.

**The `audio` facet** ✅ — a genuine advantage, and **OneDrive Personal only**
OneDrive extracts ID3 tags server-side. Add `audio` to `$select` on the delta query and get, per file, without downloading a byte:
`album, albumArtist, artist, bitrate, composers, copyright, disc, duration (ms), genre, hasDrm, isVariableBitrate, title, track, year`
⇒ The entire catalog materializes from metadata alone. Neither S3, R2, nor B2 offer this. It is also a lock-in consideration: migrating means parsing ID3 yourself.

**Throttling** 🟡 — *the real operational risk*
- Microsoft publishes **no fixed limits** for OneDrive; throttling is dynamic. Global ceiling is 130,000 req/10s per app. Resource units: download = 1 RU, write = 2 RU.
- Real-world: rclone users syncing **10,000 small files** hit `Retry-After: 322` (a 5m22s enforced pause), recovering after ~20 min. Root cause per rclone's maintainer: *"429 really means 'too many requests waiting in queue at the server.'"* **Severity correlates with concurrency, not volume.** Fix that worked: fully serial.
- A user with 200,000+ files hit constant 429s; frequent full resyncs were "a major contributor."
- ⇒ **The risk is in enumeration, not playback.** Playing one talk = 1 Graph call + N direct CDN range requests (CDN requests don't hit Graph and aren't RU-charged).
  ⇒ **Hard rules: max concurrency 3 against Graph. Honour `Retry-After` exactly. Persist the deltaLink religiously. Never ship a user-facing "full rescan" button** (put it behind a long-press in developer settings).

**Metadata storage** ✅
- ❌ **Open extensions do NOT support `driveItem`.** The supported list is exactly `user, group, contact, device, event, message, organization, post, todoTask, todoTaskList`. The extensions API is off the table.
- ✅ Use a **single JSON manifest in the app folder**: `GET/PUT /me/drive/special/approot:/feast/catalog.json:/content`, scope `Files.ReadWrite.AppFolder`. Special folders auto-create on first write.
  ⚠️ **One manifest, not N sidecars.** N sidecar files = N requests = exactly the many-small-requests pattern that triggers 429s. Use ETag / `If-Match` on PUT for conflict detection, and a write-behind buffer that PUTs at most every ~30 s.

**Limits** ✅ — max file size 250 GB (irrelevant). Consumer quota is the real ceiling: 5 GB free / ~100 GB Basic / 1 TB M365 Personal / **6 TB M365 Family**.

### 4.5 Content sources

**General Conference — churchofjesuschrist.org**

✅ An undocumented but stable public JSON API, no auth:

```
GET https://www.churchofjesuschrist.org/study/api/v3/language-pages/type/content?lang=eng&uri=/general-conference/2026/04/16bednar
```

(Note: `uri` omits the `/study` prefix.) Audio at `meta.audio[0].mediaUrl`. Verified response fragment:

```json
"audio":[{"mediaUrl":"https://assets.churchofjesuschrist.org/zrcbiszst15rxdbhwuukflpsyqra0v2kbcjln34a-128k-en.mp3","variant":"audio"}]
```

- ⚠️ **The old `media2.ldscdn.org/assets/general-conference/…-64k-eng.mp3` pattern is obsolete.** Current audio is `https://assets.churchofjesuschrist.org/<40-char-opaque-hash>-128k-<2-letter-lang>.mp3`. **The hash is not derivable** from title, speaker, date, or slug. There is no constructible URL — you must read `mediaUrl` per talk.
- Passing the index URI (`uri=/general-conference/2026/04`) returns the full session manifest with per-talk title and speaker ⇒ **one request enumerates a whole conference**, then one detail request per talk.
- Metadata available: title, speaker + calling, session name, `datePublished`, canonical URI, **full transcript HTML** in `content.body`, thumbnails.
- Duration is *not* a `meta` field — it's `data-duration="778540"` (ms) and `data-duration-string="12:58"` inside `content.body` HTML. Regex it out, or read the MP3 header.
- ❌ No working official RSS feed. Legacy `feeds.lds.org` URLs are dead; `psd-podcast.s3.amazonaws.com/XML/1-audio-eng.xml` returns 404.
- ❌ yt-dlp does not support the site ([issue #5295](https://github.com/yt-dlp/yt-dlp/issues/5295), closed as not planned) — and doesn't need to, since audio is a static MP3 at a plain URL.

⚠️ **Terms of Use — read §20.1 before implementing the fetcher.** Personal downloading is expressly permitted; *automated* access is expressly prohibited. This is a real constraint and it changes the recommended design.

**BYU Speeches — speeches.byu.edu**

✅ WordPress REST API, open, no auth. Namespaces include `wp/v2`, `speeches/v1`.

```
GET https://speeches.byu.edu/wp-json/wp/v2/speech?per_page=100&orderby=date&page=N
GET https://speeches.byu.edu/wp-json/wp/v2/speech?slug=<speech-slug>
GET https://speeches.byu.edu/wp-json/wp/v2/media?search=BYUS-<Surname>&_fields=id,date,slug,source_url,mime_type,media_details
```

- Custom post type `speech`. `content.rendered` contains the **full transcript** when queried by slug. (Bulk list queries returned empty content for the two most recent items — ⚪ likely embargoed transcripts. Query individually by slug for reliability.)
- ⚠️ **The speech record does NOT contain the audio URL.** `acf` is empty; there's no enclosure field. **Resolve audio via the `media` endpoint**, which returns `source_url` (the .mp3), `mime_type: "audio/mpeg"`, and `media_details` with duration (`"30:58"` / 1858 s), bitrate, sample rate, and filesize. **Join media → speech on speaker surname + date.**
- MP3 URLs are human-readable WordPress uploads: `https://speeches.byu.edu/wp-content/uploads/2026/03/BYUS-Dixon-Sean-R.-2026_03_17-v1.0.mp3` — ⚪ pattern `BYUS-<Last>-<First>-<M.>-<YYYY_MM_DD>-v<ver>.mp3`, but punctuation and version vary, so **discover via the media API rather than constructing**.
- Taxonomies: topics are exposed as **tags** (`/wp-json/wp/v2/tags`), applying to both `post` and `speech`. **There is no speaker taxonomy in the REST API** — speaker lives in the URL path (`/talks/<speaker-slug>/<speech-slug>/`) and the title.
- Podcast feeds exist but are hosted on **Omny Studio** (`omny.fm/shows/byu-speeches/playlists/podcast`, `classic-byu-speeches`, and ~8 more). ⚪ Standard `<enclosure>` MP3s. Worth supporting as a lower-friction path.
- ⚠️ No published terms page and no explicit personal-use grant; footer is `"© 2026 All rights reserved."` No anti-robot clause either — but absence of a prohibition is not a grant. Contact: `speeches@byu.edu`.

**Existing OSS** — `spig/gc-audio` (Node; the source of the content-API discovery), `simmeringratchet/LDSGeneralConferenceDownloader`, `deanhouseholder/General-Conference-Downloader`, `leezorba/generalconference_scraper`. ⚪ Expect all to be at least partly broken — they predate the `lds.org` → `churchofjesuschrist.org` migration and the CDN change. No dedicated BYU Speeches scraper exists.

### 4.6 Local database

**`expo-sqlite@57.x` + Drizzle ORM `0.45.2`.**

- ✅ Enable FTS5 via the config plugin: `["expo-sqlite", { "enableFTS": true }]` — *"Whether to enable the FTS3, FTS4 and FTS5 extensions."* Requires a dev build (not Expo Go).
- ⚠️ **`drizzle-orm` stable is `0.45.2`. Do not use the `1.0.0-rc.x` line** — it has been in RC for over a year. `drizzle-kit@0.31.10` for migrations.
- `drizzle-orm/expo-sqlite` provides `useLiveQuery()` (reactive queries backed by SQLite change notifications) and `useMigrations()`. Drizzle cannot model FTS5 virtual tables — write those with raw `sql` templates.
- Rejected: op-sqlite (faster but a third-party native module to maintain across SDK bumps; unnecessary at this scale), WatermelonDB (16 months without a release).
- ✅ **Use `react-native-mmkv` as a companion** for the high-frequency playback position write (§12.3) — not as the database.

### 4.7 Filesystem

**`expo-file-system@57.x`** — the `File`/`Directory`/`Paths` class API. The legacy `FileSystem.downloadAsync` is deprecated.

```ts
import { File, Directory, Paths } from 'expo-file-system';
const dest = new File(Paths.document, 'audio', `${talkId}.mp3`);
const task = File.createDownloadTask(url, dest, {
  onProgress: ({ bytesWritten, totalBytes }) => …
});
await task.downloadAsync();   // task.pause() / resume() / cancel()
```

⚠️ **Platform asymmetry, straight from the docstring:** *"On Android, the response body streams directly into the target file. If the download fails after it starts, a partially written file may remain… On iOS, the download first completes in a temporary location and the file is moved into place only after success."*
⇒ **On Android a partial file must be treated as corrupt.** Store `downloadState` + expected `contentLength` and verify size before marking a talk offline-available.

Also available: `Paths.availableDiskSpace` / `totalDiskSpace` (check before every download), `file.open(mode)` → `FileHandle.readBytes(n, offset)`, `file.watch(cb)`.

⚠️ **iOS storage location — this is an App Review trap:**
- `Paths.cache` (`Library/Caches`) — *"can be deleted by the system when the device runs low on storage."* The OS can purge it between launches. **Unacceptable for user-pinned downloads.**
- `Paths.document` (`Documents`) — safe from the system, **but backed up to iCloud by default**. Apple's Data Storage Guidelines require re-downloadable content to be flagged `NSURLIsExcludedFromBackupKey`. Classic rejection.
- ⚠️ **`expo-file-system@57` has no backup-exclusion API** (verified: no `isExcludedFromBackup` in `File.d.ts`, `Directory.d.ts`, `Paths.d.ts`, or the plugin).
- ⇒ **Write a ~30-line Expo Module / config plugin** calling `setResourceValue(true, forKey: .isExcludedFromBackupKey)` on the audio directory at first launch. This is the correct fix and it is small. (Fallback: store under `Library/Application Support` — but path resolution via `new Directory(Paths.document, '..', 'Application Support', …)` is undocumented and must be verified empirically.)

### 4.8 UI stack — SDK 57 pins

Use `npx expo install`; **prefer the SDK pin over npm `latest`** where they diverge.

| Concern | Package | SDK 57 pin | npm latest |
|---|---|---|---|
| Navigation | `expo-router` | `~57.0.12` | 57.0.12 |
| Animation | `react-native-reanimated` | `4.5.1` | 4.5.3 |
| Worklets runtime | `react-native-worklets` | `0.10.1` | 0.11.4 |
| Gestures | `react-native-gesture-handler` | `~2.32.0` | 3.1.0 ⚠️ stay on pin |
| Lists | `@shopify/flash-list` | `2.0.2` | 2.3.2 |
| Bottom sheet | `@gorhom/bottom-sheet` | — | `5.2.14` |
| Styling | `nativewind` | — | `4.2.6` ⚠️ **not** the v5 preview |
| Images | `expo-image` | `~57.0.2` | |
| Screens / safe area | `react-native-screens` / `-safe-area-context` | `~4.26.0` / `~5.7.0` | |
| SVG | `react-native-svg` | `15.15.4` | |

Also: `@tanstack/react-query@5.101.4` (URL-minting with retry/backoff), `zustand@5.0.15` (player UI state), `@react-native-community/netinfo@12.0.1` (Wi-Fi gating; distinguishing 403-expiry from offline), `react-native-edge-to-edge@1.8.1` (Android 15+ requires edge-to-edge), `react-native-mmkv@4.3.2`.

⚠️ Reanimated 4 is New-Arch-only (peer `react-native: 0.83–0.86`). Known SDK 57 issue: **25–30% memory increase when importing Reanimated with Hermes V1**. Watch it if artwork caching gets heavy.
⚠️ FlashList v2 is a New-Arch rewrite — no `estimatedItemSize`, automatic sizing. SDK pins `2.0.2` while `2.3.2` is current; upgrading past the pin is usually safe (peer deps are `*`) but validate.

### 4.9 Car integration (Phase 6+, do not attempt early)

- **Android Auto** requires a Media3 **`MediaLibraryService`** with a browse tree. ⚠️ `expo-audio` ships a `MediaSessionService` but **exposes no browse-tree API** ⇒ **expo-audio alone will not deliver Android Auto.** It needs `@rntp/player` (commercial) or a custom Expo Module. Feasible without ejecting — you write a config plugin (`withAndroidManifest` + `withDangerousMod` for `res/xml/automotive_app_desc.xml`).
- **CarPlay** requires an **Apple entitlement** (`com.apple.developer.carplay-audio`), manually granted, discretionary, expects a real published audio app. Cannot even be tested in the simulator without it. `react-native-carplay` (birkir) is stale (2.4.1-beta.0, Jun 2024); the maintained fork is **`@g4rb4g3/react-native-carplay@2.7.22`**. No official Expo plugin — vendor a community one into the repo.
- ⇒ **Sequencing:** ship phone-only → perfect the lock screen → Android Auto → request the CarPlay entitlement once there's a shipped app to point at → CarPlay last.

---

## 5. System architecture

Three components, one contract. **No server, ever.** OneDrive is the sync bus.

```
┌───────────────────────────────┐         ┌──────────────────────────────────┐
│  feast-ingest  (desktop CLI)  │         │  feast-app   (iOS + Android)     │
│  Node 22 + TypeScript         │         │  Expo SDK 57 / RN 0.86           │
│                               │         │                                  │
│  • Import existing archive    │         │  • Reads catalog.json → SQLite   │
│  • Dedup by content hash      │         │  • Streams via Range on signed   │
│  • Fetch: General Conference  │         │    URLs; LRU disk cache          │
│  • Fetch: BYU Speeches        │         │  • Collections / tags / ratings  │
│  • Optional AAC transcode     │         │  • FTS5 over titles+transcripts  │
│  • Writes catalog.json        │         │  • Queues fetch jobs → jobs/     │
│  • Executes jobs/, writes     │         │  • Writes state → state.json     │
│    results/                   │         │                                  │
└──────────────┬────────────────┘         └───────────────┬──────────────────┘
               │                                          │
               │        ┌──────────────────────┐          │
               └───────▶│      OneDrive        │◀─────────┘
                        │  (the only backend)  │
                        │                      │
                        │ /Talks/…  audio      │
                        │ /Apps/Feast/         │  SINGLE WRITER PER FILE
                        │   catalog.json       │  ← ingest writes, app reads
                        │   transcripts-*.ndjson  ← ingest writes, app reads
                        │   state.json         │  ← app writes (ETag guarded)
                        │   jobs/<id>.json     │  ← app writes, ingest reads
                        │   results/<id>.json  │  ← ingest writes, app reads
                        └──────────────────────┘
```

### Why the fetcher lives on the desktop

1. **Bandwidth.** A conference year is ~2 GB. A phone should not download 2 GB only to upload it back to OneDrive.
2. **App Store surface.** A mobile app that bulk-downloads third-party copyrighted media is a review risk. A personal CLI on the user's own PC is not.
3. **It's where OneDrive already is.** The ingest tool writes to the *local* OneDrive folder; the native sync client handles the upload — no Graph writes, no throttling, no upload code at all.
4. **ffmpeg.** Transcoding is a desktop job.

The app can still *initiate* mass downloads: it writes `jobs/<jobId>.json`, and the desktop tool picks it up on its next run (or via a watch loop / Task Scheduler) and answers with `results/<jobId>.json`. **Remote control with no server.**

### Monorepo

```
feast/
├── packages/
│   ├── core/          # Shared TS. Types, catalog schema (zod), path/slug utils,
│   │                  # speaker canonicalization, import mapping rules. NO I/O.
│   ├── storage/       # StorageProvider interface + OneDriveProvider.
│   │                  # THE ONLY place Microsoft Graph types may appear.
│   └── sources/       # SourceAdapter interface + GeneralConference, BYUSpeeches,
│                      # OmnyRSS, GenericRSS, DirectURL adapters.
├── apps/
│   ├── ingest/        # Node CLI. Depends on core + sources (+ storage for jobs).
│   └── mobile/        # Expo app. Depends on core + storage.
└── docs/              # This spec, ADRs, the import mapping table.
```

Use pnpm workspaces + TypeScript project references. Strict mode everywhere. `packages/core` must have zero runtime dependencies beyond `zod`.

---

## 6. Data model

Two representations of the same truth: `catalog.json` (portable, in OneDrive) and SQLite (indexed, on device).

### 6.0 Two cross-cutting conventions — read first

**Date codec.** `catalog.json` and `state.json` use **ISO-8601 strings**. SQLite stores **epoch milliseconds (INTEGER)**. Every conversion goes through `packages/core/src/codec.ts` — nowhere else. The one exception is `ListenState.updatedAt`, which is epoch-ms *everywhere*, because it is a logical clock rather than a date.

**Two hashes, not one.** These are different values and must never be compared:

| Field | Computed by | Definition | Used for |
|---|---|---|---|
| `contentHash` | `feast-ingest` | SHA-256 over (first 1 MB ‖ last 1 MB ‖ file size), hex. `--thorough` uses the full file. | **Dedup, stable talk identity, provider-independent references.** Survives migration to any backend. |
| `providerHash` | the storage provider | Whatever the backend reports — OneDrive `quickXorHash`/`sha1`, S3 ETag, B2 sha1 | **Change detection inside `packages/storage/` only.** Never leaves it. |

### 6.1 Core entities

```ts
/** A talk is an ENTITY, not a file. This is the fix for P2/P3. */
interface Talk {
  id: string;                   // UUIDv7, generated at import, STABLE FOREVER
  contentHash: string;          // §6.0 — the dedup key, provider-independent

  title: string;
  subtitle?: string;
  speakerId: string;
  speakerName: string;          // DENORMALIZED — required by the FTS5 external-content
                                //   table (§6.2). Refresh on speaker rename.
  seriesId?: string;
  partNumber?: number;          // "Part 03 (17 Points of the True Church)" → 3

  durationSec?: number;
  publishedAt?: string;         // ISO 8601, if known
  recordedYear?: number;
  eventName?: string;           // "October 2024 General Conference", "BYU Devotional"
  sessionName?: string;         // "Saturday Morning Session"

  // --- storage (all provider-relative logical paths, NEVER provider IDs) ---
  archivePath: string;          // "Talks/By Speaker/Prophets/17 Russell M. Nelson/x.mp3"
  streamPath?: string;          // "Talks/_stream/<id>.m4a" — the transcode (§2)
  sizeBytes: number;
  streamSizeBytes?: number;
  mimeType: string;

  // --- presentation ---
  artworkPath?: string;         // "Talks/_artwork/<id>.jpg" — extracted at import (§9.2)
  artworkColor?: string;        // "#3A4A6B" dominant color; drives the gradient fallback

  // --- text ---
  transcript?: string;          // plain text. NOT stored in catalog.json — see §6.3
  transcriptSource?: 'church-api' | 'byu-api' | 'user' | 'whisper';
  sourceUrl?: string;           // canonical web page

  // --- provenance ---
  source: 'import' | 'general-conference' | 'byu-speeches' | 'rss' | 'manual';
  importedAt: string;
  originalPaths: string[];      // EVERY path this content was found at — see §9.3
  parseConfidence: number;      // 0..1 from §9.5. < 0.7 ⇒ Needs Attention (§15.14)

  // --- health ---
  flags: TalkFlag[];
}

type TalkFlag =
  | 'needs-redownload'    // from My List/_Redownload
  | 'needs-attribution'   // speaker unknown or ambiguous
  | 'low-quality'         // bitrate below threshold
  | 'incomplete'          // duration far below series peers
  | 'duplicate-source'    // same content reached us from two sources
  | 'download-failed'     // cache download failed or verified corrupt
  | 'unplayable-format';  // e.g. the one .wma

interface Speaker {
  id: string;                   // slug: "russell-m-nelson"
  name: string;                 // "Russell M. Nelson"
  sortName: string;             // "Nelson, Russell M."
  role: 'prophet' | 'apostle' | 'seventy' | 'auxiliary' | 'scholar' | 'other';
  successionOrder?: number;     // 17 for Nelson — parsed from the "17 " folder prefix
  aliases: string[];            // ["Russell M Nelson", "Pres. Nelson", "President Nelson"]
  photoPath?: string;
  gradientSeed: string;         // deterministic fallback artwork when photoPath is absent
  bio?: string;
}

/** A multi-part set: a lecture series, a podcast show, an audiobook.
 *  Distinct from Collection: a Series is intrinsic to the content and
 *  ORDERED BY partNumber; a Collection is the user's curation. */
interface Series {
  id: string;                   // slug: "dead-sea-scrolls"
  name: string;
  kind: 'lecture' | 'podcast' | 'audiobook' | 'conference' | 'other';
  speakerId?: string;           // when a series has one presenter
  description?: string;
  artworkPath?: string;
  totalParts?: number;          // declared count, when known; else derived
}

/** Ordered, user-curated, NESTABLE. The successor to "My List/_Greatest of All". */
interface Collection {
  id: string;
  name: string;
  description?: string;
  kind: 'user' | 'smart' | 'system';
  origin: 'catalog' | 'device'; // §12.1 — catalog sync may ONLY delete origin:'catalog'
  icon?: string;
  color?: string;
  sortOrder: number;
  parentId?: string;            // collections nest — mirrors the folder tree
  smartQuery?: SmartQuery;      // kind === 'smart' only
  pinned: boolean;              // Tier 3: keep every member offline
  updatedAt: number;            // epoch ms
  deletedAt?: number;           // SOFT DELETE. Never hard-delete a syncable row.
  deviceId: string;
}

interface CollectionMember {
  collectionId: string;
  talkId: string;
  /** Fractional index (e.g. "a0", "a0V"). ⚠️ Two devices CAN generate the same key
   *  between the same neighbours — that is a known limitation of the technique.
   *  Therefore: suffix every key with the deviceId, and sort by (orderKey, talkId).
   *  Use the `fractional-indexing` package; do not hand-roll it. */
  orderKey: string;
  origin: 'catalog' | 'device';
  addedAt: string;
  updatedAt: number;
  deletedAt?: number;
  deviceId: string;
}

/** Free-form, many-to-many. Topics, feelings, whatever. */
interface Tag {
  id: string; name: string; color?: string;
  kind: 'topic' | 'scripture' | 'user';
  origin: 'catalog' | 'device';
  updatedAt: number; deletedAt?: number; deviceId: string;
}

/** The saved-search DSL. A saved search IS a smart collection (§13). */
interface SmartQuery {
  match?: string;                       // FTS5 query string
  filters: SmartFilter[];               // ANDed together
  sort: { by: 'title'|'speaker'|'duration'|'addedAt'|'lastPlayedAt'|'rating'|'random';
          dir: 'asc'|'desc' };
  limit?: number;
}
type SmartFilter =
  | { field: 'speakerId'|'seriesId'|'collectionId'|'tagId'; op: 'in'; values: string[] }
  | { field: 'role'; op: 'in'; values: Speaker['role'][] }
  | { field: 'rating'|'durationSec'|'recordedYear'; op: 'gte'|'lte'|'eq'; value: number }
  | { field: 'played'|'favorite'|'downloaded'|'pinned'; op: 'is'; value: boolean }
  | { field: 'flags'; op: 'has'; value: TalkFlag };

/** Per-talk user state. Syncs bidirectionally. */
interface ListenState {
  talkId: string;
  positionSec: number;
  played: boolean;
  playCount: number;
  completedAt?: string;
  rating?: 1 | 2 | 3 | 4 | 5;   // "_Greatest of All" → 5, "_Second Greatest" → 4
  favorite: boolean;
  note?: string;
  updatedAt: number;            // epoch ms — the LWW clock
  deviceId: string;
}

/** Timestamped bookmarks within a talk. High-value, low-cost. */
interface Bookmark {
  id: string; talkId: string; positionSec: number;
  label?: string; note?: string; createdAt: string;
  updatedAt: number; deletedAt?: number; deviceId: string;
}

interface CacheEntry {
  talkId: string;
  rendition: 'archive' | 'stream';
  localPath: string;            // <docs>/feast/audio/<talkId>.<rendition>.<ext> — §11.3
  bytes: number;
  contentLength: number;        // expected size — Android partial-file guard (§4.7)
  state: 'pending' | 'downloading' | 'complete' | 'failed';
  pinned: boolean;              // true ⇒ never LRU-evicted, never counts against budget
  lastPlayedAt: number;         // 0 = never played
  downloadedAt: number;
}

/** PDFs and books. Phase 6 — modeled now so the catalog schema is stable. */
interface Document {
  id: string; title: string; speakerId?: string; seriesId?: string;
  archivePath: string; sizeBytes: number; pageCount?: number;
  kind: 'talk-pdf' | 'book-pdf'; importedAt: string;
}
```

### 6.2 SQLite schema

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE speakers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT NOT NULL,
  role TEXT NOT NULL, succession_order INTEGER,
  aliases TEXT NOT NULL DEFAULT '[]',    -- JSON array
  photo_path TEXT, gradient_seed TEXT NOT NULL, bio TEXT
);

CREATE TABLE series (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'other',
  speaker_id TEXT REFERENCES speakers(id), description TEXT,
  artwork_path TEXT, total_parts INTEGER
);

-- ⚠️ rowid is EXPLICIT and INTEGER PRIMARY KEY. This is mandatory: the FTS5
-- external-content table below maps on rowid, and SQLite may renumber implicit
-- rowids during VACUUM. `id` remains the stable public key.
CREATE TABLE talks (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  title TEXT NOT NULL, subtitle TEXT,
  speaker_id TEXT REFERENCES speakers(id),
  speaker_name TEXT NOT NULL DEFAULT '',   -- denormalized for FTS5 (§6.1)
  series_id TEXT REFERENCES series(id), part_number INTEGER,
  duration_sec INTEGER, published_at INTEGER, recorded_year INTEGER,
  event_name TEXT, session_name TEXT,
  archive_path TEXT NOT NULL, stream_path TEXT,
  size_bytes INTEGER NOT NULL, stream_size_bytes INTEGER,
  mime_type TEXT NOT NULL,
  artwork_path TEXT, artwork_color TEXT,
  transcript TEXT, transcript_source TEXT, source_url TEXT,
  source TEXT NOT NULL, imported_at INTEGER NOT NULL,
  original_paths TEXT NOT NULL DEFAULT '[]',
  parse_confidence REAL NOT NULL DEFAULT 1.0,
  flags TEXT NOT NULL DEFAULT '[]',
  missing_since INTEGER            -- §12.1: soft-hide, NEVER hard-delete on catalog sync
);
CREATE INDEX idx_talks_speaker  ON talks(speaker_id, published_at DESC);
CREATE INDEX idx_talks_series   ON talks(series_id, part_number);
CREATE INDEX idx_talks_year     ON talks(recorded_year DESC);
CREATE INDEX idx_talks_missing  ON talks(missing_since) WHERE missing_since IS NOT NULL;
CREATE INDEX idx_talks_attention ON talks(parse_confidence) WHERE parse_confidence < 0.7;
CREATE UNIQUE INDEX idx_talks_hash ON talks(content_hash);   -- dedup enforced by the DB

-- `origin` governs deletion authority: catalog sync may only remove origin='catalog'
-- rows. Every device-created row survives every catalog sync. See §12.1 / B4.
CREATE TABLE collections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
  kind TEXT NOT NULL DEFAULT 'user',
  origin TEXT NOT NULL DEFAULT 'device',
  icon TEXT, color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT REFERENCES collections(id),
  smart_query TEXT, pinned INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, deleted_at INTEGER, device_id TEXT NOT NULL
);
CREATE INDEX idx_coll_parent ON collections(parent_id, sort_order) WHERE deleted_at IS NULL;

CREATE TABLE collection_members (
  collection_id TEXT NOT NULL REFERENCES collections(id),
  talk_id       TEXT NOT NULL REFERENCES talks(id),
  order_key     TEXT NOT NULL,       -- fractional index, deviceId-suffixed
  origin        TEXT NOT NULL DEFAULT 'device',
  added_at      INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL, deleted_at INTEGER, device_id TEXT NOT NULL,
  PRIMARY KEY (collection_id, talk_id)
);
-- ⚠️ NO `ON DELETE CASCADE` anywhere on syncable tables. Cascades turn a transient
-- catalog shrink into permanent loss of the user's ratings and curation.
CREATE INDEX idx_cm_order ON collection_members(collection_id, order_key, talk_id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_cm_talk  ON collection_members(talk_id) WHERE deleted_at IS NULL;

CREATE TABLE tags (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT,
  kind TEXT NOT NULL DEFAULT 'user', origin TEXT NOT NULL DEFAULT 'device',
  updated_at INTEGER NOT NULL, deleted_at INTEGER, device_id TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_tags_name ON tags(name) WHERE deleted_at IS NULL;

CREATE TABLE talk_tags (
  talk_id TEXT NOT NULL REFERENCES talks(id),
  tag_id  TEXT NOT NULL REFERENCES tags(id),
  origin  TEXT NOT NULL DEFAULT 'device',
  updated_at INTEGER NOT NULL, deleted_at INTEGER, device_id TEXT NOT NULL,
  PRIMARY KEY (talk_id, tag_id)
);
CREATE INDEX idx_tt_tag ON talk_tags(tag_id, talk_id) WHERE deleted_at IS NULL;

CREATE TABLE listen_state (
  talk_id TEXT PRIMARY KEY REFERENCES talks(id) ON DELETE CASCADE,
  position_sec REAL NOT NULL DEFAULT 0,
  played INTEGER NOT NULL DEFAULT 0,
  play_count INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER, rating INTEGER, favorite INTEGER NOT NULL DEFAULT 0,
  note TEXT, updated_at INTEGER NOT NULL, device_id TEXT NOT NULL
);
CREATE INDEX idx_listen_unplayed ON listen_state(played, updated_at DESC);
CREATE INDEX idx_listen_rating   ON listen_state(rating DESC) WHERE rating IS NOT NULL;

CREATE TABLE bookmarks (
  id TEXT PRIMARY KEY, talk_id TEXT NOT NULL REFERENCES talks(id),
  position_sec REAL NOT NULL, label TEXT, note TEXT, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, deleted_at INTEGER, device_id TEXT NOT NULL
);
CREATE INDEX idx_bm_talk ON bookmarks(talk_id, position_sec) WHERE deleted_at IS NULL;

-- Local-only. NOT synced, NOT in state.json. Rebuildable from disk at any time.
CREATE TABLE cache_entries (
  talk_id TEXT NOT NULL REFERENCES talks(id),
  rendition TEXT NOT NULL,                  -- 'archive' | 'stream'
  local_path TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0,
  content_length INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending',
  pinned INTEGER NOT NULL DEFAULT 0,
  last_played_at INTEGER NOT NULL DEFAULT 0,   -- 0 = never played
  downloaded_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (talk_id, rendition)
);
-- Eviction order = least-recently-*touched*, where a never-played download falls back
-- to its download time. Sorting on last_played_at alone would evict the preloads and
-- download-for-later items first — exactly backwards. See §11.3.
CREATE INDEX idx_cache_lru ON cache_entries(pinned, last_played_at, downloaded_at);

-- Fractional order_key, same scheme as collection_members — the queue is drag-reorderable
-- (§15.9), so an INTEGER PRIMARY KEY position would require renumbering on every move.
CREATE TABLE queue (
  talk_id   TEXT PRIMARY KEY REFERENCES talks(id),
  order_key TEXT NOT NULL,
  added_at  INTEGER NOT NULL
);
CREATE INDEX idx_queue_order ON queue(order_key, talk_id);

-- Sync outbox. Every mutation writes here in the SAME transaction, and the flusher
-- READS the payloads — it is the change-set, not a dirty flag. See §12.2.
CREATE TABLE outbox (
  id TEXT PRIMARY KEY, entity TEXT NOT NULL, entity_id TEXT NOT NULL,
  op TEXT NOT NULL,               -- 'upsert' | 'delete'
  payload TEXT NOT NULL,          -- the CHANGED FIELDS ONLY, for correct 412 merges
  created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_outbox_order ON outbox(created_at);

CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- keys: 'catalog_etag', 'state_etag', 'catalog_version', 'device_id',
--       'last_catalog_sync', 'last_state_flush', 'transcript_shard_etags'

-- ── FTS5 ────────────────────────────────────────────────────────────────────────
-- External-content: no text duplication, but the contentless columns MUST all exist
-- on `talks`, because FTS5 issues `SELECT title, transcript, speaker_name FROM talks
-- WHERE rowid = ?` for rebuild, integrity-check, snippet() and highlight().
CREATE VIRTUAL TABLE talks_fts USING fts5(
  title, transcript, speaker_name,
  content='talks', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- ⚠️ The 'delete' command BEFORE every update/delete is mandatory. Omitting it is the
-- single most common cause of a corrupt external-content FTS5 index.
CREATE TRIGGER talks_ai AFTER INSERT ON talks BEGIN
  INSERT INTO talks_fts(rowid, title, transcript, speaker_name)
  VALUES (new.rowid, new.title, new.transcript, new.speaker_name);
END;
CREATE TRIGGER talks_ad AFTER DELETE ON talks BEGIN
  INSERT INTO talks_fts(talks_fts, rowid, title, transcript, speaker_name)
  VALUES ('delete', old.rowid, old.title, old.transcript, old.speaker_name);
END;
CREATE TRIGGER talks_au AFTER UPDATE ON talks BEGIN
  INSERT INTO talks_fts(talks_fts, rowid, title, transcript, speaker_name)
  VALUES ('delete', old.rowid, old.title, old.transcript, old.speaker_name);
  INSERT INTO talks_fts(rowid, title, transcript, speaker_name)
  VALUES (new.rowid, new.title, new.transcript, new.speaker_name);
END;
```

**The search query must join back to `talks`** — FTS5 returns rowids, and the app needs `talks.id`:

```sql
SELECT t.id, t.title, t.speaker_name, t.duration_sec,
       snippet(talks_fts, 1, '<b>', '</b>', '…', 24) AS snip
FROM talks_fts f
JOIN talks t ON t.rowid = f.rowid
WHERE talks_fts MATCH ?1 AND t.missing_since IS NULL
ORDER BY bm25(talks_fts, 10.0, 1.0, 5.0)   -- title ≫ speaker > transcript
LIMIT 50;
```

### 6.3 The OneDrive files

Layout under the app folder — **single-writer per file**, which is what makes a serverless design safe:

```
/Apps/Feast/
├── catalog.json                 ingest writes · app reads         (never app-written)
├── transcripts-000.ndjson       ingest writes · app reads         (~200 talks per shard)
├── transcripts-001.ndjson       …
├── state.json                   app writes   · ingest reads       (never ingest-written)
├── jobs/<jobId>.json            app writes   · ingest reads       (append-only, immutable)
└── results/<jobId>.json         ingest writes · app reads         (one per job)
```

⚠️ **Never have two writers on one document.** The earlier draft had the app and ingest both mutating `jobs.json`, which guarantees lost jobs and OneDrive conflict copies (`jobs-DESKTOP-XYZ.json`). One file, one writer, always.

**`catalog.json`** — the full library, minus transcripts.

```jsonc
{
  "version": 1,                        // bump on schema change; §12.1 defines migration
  "generatedAt": "2026-08-13T18:22:11Z",
  "generatedBy": "feast-ingest@0.4.1",
  "root": "Talks",                     // provider-relative library root
  "counts": { "talks": 1875, "speakers": 34, "series": 19, "collections": 12 },
  "transcriptShards": ["transcripts-000.ndjson", "transcripts-001.ndjson"],
  "allowShrink": false,                // §12.1 guard — must be true to accept a big drop

  "speakers":    [ /* Speaker[] */ ],
  "series":      [ /* Series[] */ ],
  "talks":       [ /* Talk[] — `transcript` omitted */ ],
  "collections": [ /* Collection[], all origin:'catalog' */ ],
  "collectionMembers": [ /* CollectionMember[], all origin:'catalog' */ ],
  "tags":        [ /* Tag[] */ ],
  "talkTags":    [ ["talkId","tagId"], … ],
  "documents":   [ /* Document[] — Phase 6 */ ],

  // The ONLY channel by which ingest can seed user state. Applied ONCE, on first
  // insert of a talk id, and NEVER thereafter — otherwise every catalog sync would
  // reset the user's listening progress. This is what makes §9.4's folder-semantics
  // mapping (_Listened To → played, _Greatest of All → 5 stars) actually reach the app.
  "seedState": {
    "listenState": [ { "talkId": "…", "played": true, "rating": 5 }, … ],
    "queue": [ "talkId", … ]
  }
}
```

⚪ Size: a transcript-free `Talk` serializes to ~600–750 bytes, so ~1,875 talks + speakers + series + members ≈ **1.5–2 MB**. One GET, gzip-friendly. Revisit sharding past ~10,000 talks.

**`transcripts-NNN.ndjson`** — one JSON object per line, `{"talkId":"…","text":"…"}`, ~200 talks per shard.

⚠️ **Not one file per talk.** §4.4 is explicit: N small files = N requests = precisely the pattern that triggered `Retry-After: 322` for rclone users at 10,000 files. Fetching 1,875 individual transcripts at the mandated concurrency ≤3 would be both slow and a throttling trigger. Shards make it ~10 GETs. Each shard is ETag-tracked in `sync_meta.transcript_shard_etags` and prefetched in the background over Wi-Fi.

**`state.json`** — app-written only. ETag-guarded PUT, write-behind ≥30 s.

```jsonc
{
  "version": 1,
  "deviceId": "…", "updatedAt": 1786623341615,
  "listenState": [ /* ListenState[] */ ],
  "bookmarks":   [ /* Bookmark[], incl. soft-deleted */ ],
  // ⚠️ ALL device-origin curation, including memberships added to CATALOG-origin
  // collections. Without this, adding a talk to "Greatest of All" on the phone is
  // erased by the next catalog sync — killing the core organize workflow.
  "collections":       [ /* Collection[] where origin='device' */ ],
  "collectionMembers": [ /* CollectionMember[] where origin='device' */ ],
  "tags":     [ /* Tag[] where origin='device' */ ],
  "talkTags": [ /* TalkTag[] where origin='device' */ ],
  "queue": [ { "talkId": "…", "orderKey": "a0:dev1" }, … ]
}
```

Soft-deleted rows (`deletedAt` set) are **included** — a tombstone is the only way to express a removal across devices (§12.4).

**`jobs/<jobId>.json`** — immutable once written. The app→desktop remote control.

```jsonc
{ "id": "01J…", "version": 1, "createdAt": "2026-08-13T18:30:00Z", "deviceId": "…",
  "kind": "fetch-gc-speaker",
  "params": { "speaker": "Jeffrey R. Holland", "since": 1994, "lang": "eng" } }
```

Job kinds: `fetch-gc-session` · `fetch-gc-speaker` · `fetch-byu-speaker` · `fetch-byu-recent` · `fetch-rss` · `fetch-url` · `redownload` · `transcode` · `transcribe` · `reindex`.

**`results/<jobId>.json`** — written once by ingest when the job settles.

```jsonc
{ "id": "01J…", "status": "done", "startedAt": "…", "completedAt": "…",
  "result": { "added": 47, "skipped": 3, "failed": 0, "bytes": 1183842304 },
  "log": ["…"], "error": null }
```

The app polls the `results/` folder listing (one cheap Graph call) to show job status; absence of a result file means still pending.

---

## 7. `StorageProvider` — the migration insurance policy

The user's library will grow past OneDrive eventually (consumer ceiling: 6 TB on M365 Family). **Every candidate backend converges on the same primitive: "give me a time-limited, auth-free, Range-capable URL."** OneDrive calls it `@microsoft.graph.downloadUrl`; S3/R2/B2 call it a presigned GET. Build the interface around that and the player never learns the difference.

### 7.1 ⚠️ Addressing: the app holds paths, not IDs

This is the subtlest and most load-bearing decision in the document, and getting it wrong makes playback impossible.

`catalog.json` contains **logical paths only** — `"Talks/By Speaker/Prophets/17 Russell M. Nelson/x.mp3"`. It contains no driveItem IDs, because IDs are provider-specific and would not survive a backend migration. But `GET /me/drive/items/{id}/content` wants an ID. **Something has to bridge that gap, and it must be inside the provider.**

Therefore every playback-path method takes a `StorageRef`, and `OneDriveProvider` owns the translation:

```ts
export type StorageRef = { path: string } | { id: string };
```

`OneDriveProvider` resolution order:
1. **In-memory + persisted `path → driveItemId` map**, populated from delta runs and every prior resolution. Hit ⇒ zero extra round trips.
2. **Miss ⇒ path addressing**, which Graph supports directly and which needs no map at all:
   `GET /me/drive/root:/{urlEncodedPath}?$select=id,@microsoft.graph.downloadUrl` — **one** call, returning both the ID (cache it) and the signed URL.
3. `404` ⇒ throw `StorageError('not-found', path)`. The caller marks the talk `missing_since` and shows "This file has moved or been removed — re-run `feast import`."

⇒ **Streaming a talk costs exactly one Graph call in every case**, which is what §17's < 1.5 s budget assumes. The app never runs its own delta enumeration; only ingest does. That keeps the throttling risk of §4.4 entirely on the desktop, where it belongs.

⚠️ **Consequence for `feast dedupe --apply` and any other operation that moves files:** moving a file invalidates its cached ID *and* its path. Any command that relocates audio **must** rewrite `archivePath`/`originalPaths` and re-emit `catalog.json` in the same run (§9.3). A moved file with a stale catalog is an unresolvable talk.

### 7.2 The interface

```ts
// packages/storage/src/types.ts
export interface StorageItem {
  id: string;               // provider-specific and OPAQUE (driveItem id | object key)
  path: string;             // provider-NEUTRAL logical path — "Talks/By Speaker/…/x.mp3"
  name: string;
  size: number;
  providerHash?: string;    // §6.0 — provider-reported. NOT the dedup key.
  modifiedAt: string;
  audio?: AudioTags;        // OneDrive: free (audio facet). Others: parse ID3 client-side.
}

export interface SignedUrl {
  url: string;              // NO auth headers required
  expiresAt: number;        // epoch ms — ADVISORY ONLY. Callers must assume it can be wrong.
  supportsRange: boolean;   // true for all four backends
}

export interface StorageProvider {
  readonly id: 'onedrive' | 'r2' | 'b2' | 's3';

  // enumeration (INGEST ONLY — the mobile app never calls these) --------
  list(o: { prefix?: string; cursor?: string; pageSize?: number }):
    Promise<{ items: StorageItem[]; cursor?: string; done: boolean }>;

  /** OneDrive → native /delta. Object stores → full list + local diff.
   *  `full: true` means "treat as reconciliation, not patch" (OneDrive HTTP 410). */
  changesSince(cursor?: string):
    Promise<{ upserted: StorageItem[]; deletedIds: string[]; cursor: string; full: boolean }>;

  // playback (THE hot path — cheap, and safely re-callable at any moment) -
  getStreamUrl(ref: StorageRef, ttlHint?: number): Promise<SignedUrl>;
  openRange(ref: StorageRef, start: number, end?: number): Promise<ReadableStream>;
  stat(ref: StorageRef): Promise<StorageItem | null>;

  // app documents ------------------------------------------------------
  readAppFile(name: string): Promise<{ data: Uint8Array; etag?: string } | null>;
  writeAppFile(name: string, data: Uint8Array, ifMatch?: string): Promise<{ etag: string }>;
  listAppFiles(prefix: string): Promise<{ name: string; modifiedAt: string }[]>;
}
```

**Four rules that make the eventual swap cheap:**

1. **Never let a provider-specific ID escape `packages/storage/`.** Nothing outside it may store, log, or serialize a driveItem ID. Everything above the boundary addresses content by **logical `path`**, with `contentHash` (§6.0) as the identity check. Migration = repoint the provider and re-index; every collection, rating, and bookmark survives untouched. This is the most important rule in this section.
2. **Treat `expiresAt` as advisory.** The recovery path of §11.4 must work regardless of what it says.
3. **Push ID3 parsing behind the provider.** OneDrive fills `audio` free; object stores implement it by range-reading the first ~256 KB at index time. Same `StorageItem` either way.
4. **Keep the manifest format provider-neutral JSON.** `/Apps/Feast/catalog.json` → object key `_app/catalog.json`.

⚪ Realistic migration cost with this in place: **one new file, ~300–500 LOC, plus a re-index run.** Zero changes to UI, player, or collections.

### Cost reality — this cuts against the intuition

| Backend | 1 TB stored, 200 GB/mo streamed | 5 TB stored, 1 TB/mo streamed |
|---|---|---|
| **OneDrive (M365 Personal / Family)** | **~$8/mo** ⚪ | **~$11/mo** ⚪ (6 TB Family) |
| Backblaze B2 | ~$7/mo | ~$35/mo |
| Cloudflare R2 | ~$15/mo | ~$77/mo |
| AWS S3 Standard | ~$33/mo | ~$201/mo |

✅ R2: $0.015/GB-mo, **free egress**. ✅ B2: $6.95/TB-mo, free egress to 3× stored, **free API calls**. ✅ S3: $0.023/GB-mo + **$0.09/GB egress** — actively hostile to media streaming.

⇒ **Cost is not a reason to leave OneDrive.** The real migration triggers are: the **6 TB consumer ceiling**, wanting **CDN caching**, going **multi-user**, or being unwilling to build on undocumented dynamic rate limits. When that day comes, go to **B2** (cheapest, free egress within allowance, free API calls) or **R2** (if you want Cloudflare's CDN in front). Skip S3.

---

## 8. `SourceAdapter` — pluggable acquisition

```ts
// packages/sources/src/types.ts
export interface DiscoveredTalk {
  externalId: string;             // stable per source — the dedup key before download
  title: string; speaker: string; speakerRole?: SpeakerRole;
  audioUrl: string; durationSec?: number; sizeBytes?: number;
  publishedAt?: string; eventName?: string; sessionName?: string;
  transcript?: string; sourceUrl: string;
  suggestedPath: string;          // where in the archive this should land
  suggestedTags: string[];
}

export interface SourceAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly requiresPoliteRateLimit: boolean;   // see §20.1

  /** Browsable hierarchy: years → sessions, speakers → speeches, shows → episodes. */
  browse(node?: string): Promise<BrowseNode[]>;

  /** Enumerate everything under a node WITHOUT downloading audio. */
  discover(node: string, opts?: { limit?: number }): Promise<DiscoveredTalk[]>;

  /** Optional second pass when transcripts need a per-item request. */
  hydrate?(talk: DiscoveredTalk): Promise<DiscoveredTalk>;
}
```

Ship five adapters:

| Adapter | Mechanism |
|---|---|
| `general-conference` | `/study/api/v3/language-pages/type/content` (§4.5). Index URI enumerates a conference; detail URI yields `meta.audio[0].mediaUrl` + transcript. Duration regex'd from `data-duration` in `content.body`. **`requiresPoliteRateLimit: true`.** |
| `byu-speeches` | `wp/v2/speech` for metadata + transcript; `wp/v2/media?search=<Surname>&mime_type=audio/mpeg` for `source_url` + duration; join on surname + date. |
| `omny-rss` | The 10 BYU Speeches podcast feeds on omnycontent.com. Standard `<enclosure>`. Lowest friction — prefer where it covers the need. |
| `generic-rss` | Any podcast feed (covers the existing `Podcasts/First Vision Podcast` folder). |
| `direct-url` | Paste a URL or drop a file. Always available; the manual escape hatch. |

**Shared fetch discipline for every adapter** (`packages/sources/src/http.ts`):
- Serial by default; concurrency **1** for `requiresPoliteRateLimit` sources, max 3 otherwise.
- ≥1,000 ms between requests to the same host.
- Honest, identifying `User-Agent`: `Feast/0.4 (personal archive tool; <contact email>)`.
- Respect `Retry-After` exactly. Exponential backoff with jitter otherwise. Resumable via `Range` on interrupted downloads.
- Conditional requests (`If-None-Match` / `If-Modified-Since`) so re-runs are nearly free.
- A persistent `.feast-fetch-cache.json` so a re-run never re-downloads anything.

---

## 9. `feast-ingest` — the desktop companion

Node 22 + TypeScript. Distributed as a single `npx feast` (or a `.cmd` shortcut on the user's PC).

**Two transports, deliberately split:**

| What | How | Why |
|---|---|---|
| **Audio files, artwork** | plain `fs` against the **local OneDrive folder** | 24 GB through Graph would be absurd; the sync client already does this well, and it costs zero API quota |
| **The three app documents** (`catalog.json`, transcript shards, `jobs/`, `results/`) | **Microsoft Graph**, via `packages/storage` | ETag/`If-Match` conflict detection is the whole point; writing them through the synced folder would produce `catalog-DESKTOP-XYZ.json` conflict copies instead of a clean 412 |

⇒ **The CLI needs its own auth.** `expo-secure-store` does not exist on desktop.

### 9.0 CLI authentication

`feast login` runs OAuth2 auth-code + PKCE with a **loopback redirect** (`http://localhost:<random-port>/callback`) — the standard native-app flow, registered under "Mobile and desktop applications" alongside the mobile redirect (§4.4). It opens the system browser, captures the code on a one-shot local HTTP listener, exchanges it, and writes the refresh token to `~/.feast/auth.json` with `0600` permissions (DPAPI-wrapped on Windows where available).

Same scopes as the app. Same 90-day rolling refresh. `feast logout` deletes the file. Every command that touches Graph checks for a valid token first and prints `Run 'feast login' first.` rather than failing obscurely.

### 9.1 Commands

```
feast login | logout             Microsoft auth for the app documents  (§9.0)
feast init                       Interactive: point at the archive root, write .feastrc.json
feast import [--dry-run] [--thorough]
                                 Scan the archive, build/refresh catalog.json  (§9.2–9.5)
feast index [--refresh]          Build/refresh the local SOURCE index used by
                                   speaker-centric fetches  (§9.6a) — no audio downloaded
feast fetch gc --year 2026 --session 04
feast fetch gc --speaker "Jeffrey R. Holland" [--since 1994]      ← needs `feast index`
feast fetch byu --speaker "Hank Smith" [--limit 50] | --recent 20 ← needs `feast index`
feast fetch rss <feed-url> [--since 2024-01-01]
feast fetch url <audio-url> --title "…" --speaker "…"
feast jobs [--watch] [--install-service]
                                 Read jobs/, execute, write results/  (§9.7)
feast transcode [--bitrate 32k] [--codec aac-he-v2|opus]   Stream renditions  (§2)
feast transcribe [--model small] [--only-missing]           Whisper transcripts  (§9.8)
feast doctor                     Duplicates, orphans, _Redownload, unplayable formats,
                                   missing metadata, low parse confidence
feast dedupe [--apply]           Report/reclaim duplicate bytes  (§9.3)
```

`--dry-run` on every mutating command. Print a diff summary before touching anything, ever.

### 9.2 Import: reading the existing archive

1. Walk the archive root with `fs.opendir` (streaming — do not materialize 2,000 paths in memory at once).
2. For each audio file: read ID3/MP4 tags (`music-metadata`), compute the **`contentHash`** per §6.0.
3. Extract the duration from the container header rather than decoding. **Accumulate total audio-hours** — this drives the honest transcode estimate (§2).
4. **Extract embedded artwork** (ID3 `APIC` / MP4 `covr`) via `music-metadata`. If present: downscale to 512×512 JPEG q80 with `sharp`, write to `Talks/_artwork/<talkId>.jpg`, set `artworkPath`. Compute the dominant color either way and set `artworkColor`, so the gradient fallback is never ugly. **Do not attempt artwork extraction at play time** — that would require downloading the file, defeating the entire architecture.
5. Derive metadata from the path *and* tags, with **tags losing to path** where they conflict (this archive's ID3 tags are inconsistent; the folder structure is the user's real intent).
6. Assign a UUIDv7 `id`. **Once assigned, an id never changes** — persist an `id ↔ contentHash` map in `~/.feast/ids.json` so re-imports are stable and the user's ratings never orphan.
7. Emit `catalog.json` + transcript shards and PUT them via Graph with `If-Match` on the stored ETag.

### 9.3 Deduplication — a headline feature

**Verified duplicates in the real archive**, e.g. `Education Week 1998 John Bytheway - Gospel Values for Youth.mp3` (134.7 MB) exists in both `By Speaker/Others/John Bytheway/` and `My List/_Greatest of All/`. At least five large files are doubled this way.

Behavior:
1. Group files by `contentHash`.
2. **One `Talk` per hash.** Every path where it was found goes into `originalPaths[]`.
3. **Each path is run through the §9.4 mapping table and contributes its semantics** — which may be a speaker, a collection, a rating, a series, a flag, or several at once. The Bytheway lecture ends up in *both* the "John Bytheway" speaker view and the "Greatest of All" collection — **which is exactly what the user was trying to express by copying the file.** The duplication was a workaround; the app makes it native.
4. **Conflict rules when two paths disagree** (these will fire — a file can sit in both `_Greatest of All` and `_Second Greatest`):

   | Conflict | Resolution |
   |---|---|
   | Two different ratings | take the **max** |
   | Two different speakers | keep the more specific (a named speaker beats `All other Talks`); if both are named, pick neither, set `speakerId: 'unknown'` and flag **`needs-attribution`** |
   | Two different series | keep the one from the deeper path; flag if both are deep |
   | `played` disagrees | **`true` wins** (monotonic, same rule as §12.4) |
   | Collections | **union** — that's the whole point |

5. **Canonical `archivePath`:** prefer, in order, a path under `By Speaker/` → `Lectures/` → `Podcasts/` → `My List/` → first alphabetically. The rationale: `By Speaker/` is the taxonomy least likely to be reorganized.
6. `feast dedupe --apply` then offers to remove the redundant *file* copies, reporting exactly how many GB come back. **Never automatic. Always shows the list first. Moves to a `_deduped/` folder rather than deleting outright, so it is reversible.**
   ⚠️ **`--apply` must rewrite `archivePath`/`originalPaths` and re-emit `catalog.json` in the same run.** A moved file with a stale catalog is an unresolvable talk (§7.1).

Report at the end of every import: `"12 duplicate files found across 5 talks — 780 MB reclaimable. Run 'feast dedupe' to review."`

### 9.4 The Import Mapping Table

**This is where the user's folder semantics become app semantics. Implement it exactly.**

| Path pattern | Becomes |
|---|---|
| `By Speaker/Prophets/<NN> <Name>/` | Speaker `<Name>`, `role: 'prophet'`, `successionOrder: NN` |
| `By Speaker/Apostles/<Name>/` | Speaker `<Name>`, `role: 'apostle'` |
| `By Speaker/Others/<Name>/` | Speaker `<Name>`, `role: 'scholar'` (Nibley, Callister) or `'other'` |
| `By Speaker/Others/All other Talks/` | Speaker `Unknown`; flag `needs-attribution` |
| `By Speaker/_Listened To/<Name>/` | Speaker `<Name>` **+ `listenState.played = true`** |
| `My List/_Greatest of All/` | Collection "Greatest of All" **+ `listenState.rating = 5`** |
| `My List/_Second Greatest/` | Collection "Second Greatest" **+ `listenState.rating = 4`** |
| `My List/_To be Seen/` | Collection "To Be Heard" **+ appended to the queue** |
| `My List/_To be Seen/<Title>/` | Series `<Title>` (Nibley lecture sets) inside that collection |
| `My List/_Redownload/` | **`flags: ['needs-redownload']`** → surfaced in the app's Needs Attention view, and pre-fills a `redownload` job |
| `Lectures/<Series>/` | Series `<Series>`, `role` inferred from tags/speaker; collection "Lectures" |
| `Lectures/<Series>/Part NN (…)` | `partNumber: NN`, ordered within the series |
| `PDF Talks/` | `Document` with `kind: 'talk-pdf'` (reader ships in **Phase 6**; catalogued from Phase 2) |
| `PDF Talks/Dope PDF Talks/` | Collection "Dope PDF Talks" (keep the name; it's his) |
| `Podcasts/<Show>/` | Series `<Show>`, `kind: 'podcast'`, `source: 'rss'`, subscribable |
| `Books/Audio Books/` | Series `kind: 'audiobook'` — chapter-ordered, single continuous resume position |
| `Books/PDF Books/` | `Document` with `kind: 'book-pdf'` (**Phase 6**) |

**Speaker canonicalization** (`packages/core/src/speakers.ts`): a curated alias table so `"Russell M. Nelson"`, `"Russell M Nelson"`, `"President Nelson"`, `"Pres. Nelson"`, and `"Nelson, Russell M."` all resolve to `russell-m-nelson`. Seed it from the folder names found in the archive, then fuzzy-match (normalized Levenshtein ≥ 0.85) new arrivals with a **confirmation prompt** — never a silent merge.

### 9.5 Filename parsing

Real examples and what to extract:

| Filename | Extract |
|---|---|
| `Part 03 (17 Points of the True Church)-1.mp3` | part 3, series "17 Points of the True Church", strip `-1` dedupe suffix |
| `John G. Bytheway, 2006 Ed Week, Righteous Warriors - Lessons from the War Chapters.mp3` | speaker, year 2006, event "Education Week", title |
| `Education Week 2003 - John Bytheway - Especially for Young Single Adults - Who When and Why We Marry.mp3` | event + year, speaker, title |
| `06 Dead Sea Scrolls Discovery and Importance.mp3` | track 6, series "Dead Sea Scrolls", title |
| `#2 Meaning of the Atonement.mp3` | track 2, title |
| `Thou Shalt Be Nice! - Hank Smith-1.mp3` | title, speaker, strip `-1` |
| `“Finishers Wanted”.pdf` | normalize smart quotes |
| `Jerusalem_s Formula for Peace` | `_` was a stripped apostrophe → restore to `Jerusalem's` |

Rules: strip trailing `-N` / `(N)` dedupe suffixes; leading `NN ` or `#N ` is a track number; ` - ` splits title/speaker (test both orders against the speaker table); underscores adjacent to `s` are likely apostrophes; normalize smart quotes and en-dashes; title-case only when the source is ALL CAPS.

Every parse writes `parseConfidence` (0–1). Below **0.7**, the talk lands in the app's **Needs Attention** view (§15.14) for one-tap correction — the app must be able to fix bad metadata, because bad metadata will exist.

### 9.6a The source index — what makes "every talk by X" possible

⚠️ **Requirement (b) — mass-download by speaker — cannot be satisfied by either source's API directly**, and this is the reason:

- **General Conference:** audio URLs are opaque 40-char hashes readable only per-talk (§4.5). There is no speaker query. "Everything Holland ever gave" would mean enumerating ~110 conference indexes at 1 req/s ≥ 2 minutes just to *find* them — and re-doing it on every fetch.
- **BYU Speeches:** §4.5 is explicit that **there is no speaker taxonomy in the REST API**. Speaker lives in the URL path and the title, nowhere queryable.

⇒ **`feast index` builds a local, persistent, audio-free index once, and every speaker-centric command is a filter over it.**

```
~/.feast/source-index.json
{
  "gc":  { "builtAt": "…", "lastConference": "2026-04",
           "talks": [ { "uri": "/general-conference/2023/10/51nelson",
                        "title": "Think Celestial!", "speaker": "Russell M. Nelson",
                        "session": "Sunday Afternoon", "year": 2023, "month": 10 }, … ] },
  "byu": { "builtAt": "…", "lastId": 48122,
           "speeches": [ { "id": 47311, "slug": "…", "speaker": "Hank Smith",
                           "title": "…", "date": "2024-02-13" }, … ] }
}
```

- First build: one index request per conference (~110 for the full GC back catalogue) + paged `wp/v2/speech` for BYU. At the mandated 1 req/s this is ~5 minutes, run **once**.
- `--refresh` fetches only conferences newer than `lastConference` and speeches newer than `lastId`. Normally 1–2 requests.
- Speaker matching runs through the same canonicalization + alias table as §9.4, so `"Elder Holland"` and `"Jeffrey R. Holland"` resolve together.
- The index holds **no audio and no transcripts** — only what's needed to decide what to fetch. It also powers the in-app Discover browser without any live requests (§15.12).

### 9.6 Fetch pipeline

```
discover(node)                    →  DiscoveredTalk[]      (metadata only, no audio)
  ↓ filter against catalog by externalId AND contentHash   (never re-download)
  ↓ show plan: N new, M skipped, total bytes; require confirmation unless --yes
  ↓ per item, serially, rate-limited:
      GET audio (Range-resumable) → temp file
      verify Content-Length; hash
      write to suggestedPath in the local OneDrive folder
      write ID3 tags from the discovered metadata (node-id3)
      append transcript to the current transcripts-NNN.ndjson shard
  ↓ rebuild catalog.json + shards, PUT via Graph with If-Match
  ↓ print summary + reclaimable-duplicate report
```

Interruptible and resumable. `Ctrl-C` mid-fetch must leave the archive and catalog consistent.

### 9.7 `feast jobs --watch`

Lists `/Apps/Feast/jobs/` every 60 s (one Graph call), skipping any job that already has a `results/<jobId>.json`. Executes the remainder serially, then writes exactly one result file per job. **Job files are never mutated** — single-writer per file (§6.3) is what makes the whole serverless design safe.

Ships with optional Windows Task Scheduler / launchd registration (`feast jobs --install-service`) so it runs quietly at login.

### 9.8 `feast transcribe` — where transcripts for the existing archive come from

⚠️ **The 1,875 talks already in the archive have no transcript source.** §4.5 supplies transcripts only for General Conference and BYU Speeches. Education Week lectures, the Nibley sets, `Lectures/`, and loose MP3s have none anywhere. Any claim that the app ships with ~1,900 searchable transcripts is false unless this command exists.

`feast transcribe` runs **whisper.cpp** locally (`--model small` ≈ good enough for search; `medium` for reading). Opt-in, resumable, one talk at a time, writing `transcriptSource: 'whisper'`. On CPU expect roughly real-time-to-3× — i.e. **436 audio-hours is a multi-day background job**. Recommend running it as `feast transcribe --only-missing` overnight, repeatedly; it picks up where it left off.

Until it has run, search covers **titles, speakers, series, and the subset of talks with publisher transcripts** — which is still genuinely useful. Say so in the UI rather than implying full coverage.

---

## 10. `feast-app` — structure

```
apps/mobile/
├── app/                              # Expo Router
│   ├── _layout.tsx                   # Providers, DB migration gate, MiniPlayer host
│   ├── (onboarding)/
│   │   ├── welcome.tsx
│   │   ├── connect.tsx               # OneDrive OAuth
│   │   └── sync.tsx                  # first catalog pull
│   ├── (tabs)/
│   │   ├── _layout.tsx               # Home · Library · Search · Downloads
│   │   ├── index.tsx                 # Home
│   │   ├── library.tsx
│   │   ├── search.tsx
│   │   └── downloads.tsx
│   ├── talk/[id].tsx
│   ├── speaker/[id].tsx
│   ├── collection/[id].tsx
│   ├── collection/[id]/edit.tsx      # rename · move · icon · delete
│   ├── collection/new.tsx
│   ├── series/[id].tsx
│   ├── player.tsx                    # full-screen modal
│   ├── queue.tsx                     # modal
│   ├── attention.tsx                 # Needs Attention (§15.14)
│   ├── fetch/
│   │   ├── index.tsx                 # Discover hub
│   │   ├── consent.tsx               # first-run ToS gate (§15.13a)
│   │   ├── gc.tsx                    # General Conference: by speaker | by conference
│   │   ├── byu.tsx                   # BYU Speeches browser
│   │   └── jobs.tsx                  # job status from results/
│   └── settings/
│       ├── index.tsx
│       ├── storage.tsx
│       ├── playback.tsx
│       ├── sources.tsx               # per-source enable + fetch policy
│       ├── tags.tsx                  # tag management
│       ├── speakers.tsx              # alias editor / merge
│       └── account.tsx
├── src/
│   ├── db/          schema.ts · migrations/ · queries/
│   ├── player/      PlayerService.ts · queue.ts · nowPlaying.ts · store.ts
│   ├── cache/       CacheManager.ts · lru.ts · downloader.ts
│   ├── sync/        catalogSync.ts · stateSync.ts · outbox.ts
│   ├── auth/        msAuth.ts (expo-auth-session + secure-store)
│   ├── ui/          design tokens + primitives
│   └── features/    one folder per screen family
└── plugins/
    └── with-backup-exclusion.ts      # the ~30-line iOS fix from §4.7
```

---

## 11. Playback engine

### 11.1 `PlayerService` — the swap boundary

Keep this interface narrow so `@rntp/player` remains a one-file replacement if Android Auto forces the issue.

```ts
export interface PlayerService {
  load(talk: Talk, startPositionSec?: number): Promise<void>;
  play(): void; pause(): void; togglePlay(): void;
  seekTo(sec: number): Promise<void>;
  seekRelative(delta: number): Promise<void>;      // ±15 / ±30
  setRate(rate: number): void;                     // 0.8 … 3.0
  setNowPlaying(meta: NowPlayingMeta): void;
  onProgress(cb: (p: { position: number; duration: number; buffering: boolean }) => void): Unsub;
  onEnded(cb: () => void): Unsub;
  onError(cb: (e: PlayerError) => void): Unsub;
}
```

Queue management lives **above** this, in `src/player/queue.ts`, in JS — because `AudioPlaylist` has no lock-screen API (§4.2). On every track change, call `setActiveForLockScreen(true, meta, { showSeekForward: true, showSeekBackward: true })`.

### 11.2 Source resolution — the decision every `play()` makes

```
play(talk):
  1. cache hit, 'stream' rendition, state='complete', size==contentLength? → play file://
  2. cache hit, 'archive' rendition, state='complete', size==contentLength? → play file://
  3. offline (NetInfo)?          → error "Not downloaded" + offer "download when back online"
  4. cellular AND streamOnCellular off?  → error "Wi-Fi only" + offer "download later"
  5. otherwise:
       const path = talk.streamPath ?? talk.archivePath   // prefer the compact rendition
       const { url } = await storage.getStreamUrl({ path })  ← resolved NOW, never cached
       await player.replace({ uri: url })
       // Parallel cache write — but ONLY when the download policy permits it:
       if (!wifiOnlyDownloads || netInfo.type === 'wifi') {
         cache.enqueue(talk, rendition, { priority: 'now' })
       }
```

⚠️ **Step 5's parallel download must obey the Wi-Fi-only setting independently of step 4.** They are separate switches by design: §2 permits cellular *streaming* while defaulting cellular *downloads* off. An unconditional parallel download would double cellular data usage — the exact opposite of what both settings mean.

**Always prefer the `stream` rendition when it exists** (§2) — smaller cache footprint, less data, faster start.

### 11.3 Caching strategy — "stream now, cache in parallel"

⚠️ **There is no maintained open-source RN library that streams and caches to disk simultaneously.** The platform primitives exist (iOS `AVAssetResourceLoaderDelegate`, Android Media3 `CacheDataSource`), but nothing maintained exposes them to JS. `@rntp/player` v5 is the only shipping product that does it, and it's commercial.

⇒ **Use dual-fetch:** play the remote URL *and* kick off an `expo-file-system` `DownloadTask` to disk in parallel. Costs ~2× bandwidth on first play; trivially simple; robust. Perfectly acceptable for a personal app, and the transcode rendition (§2) makes the doubled cost small.

Do **not** build a local HTTP proxy. It's an extra native dependency, it fights iOS background execution, and it's a large surface area for a marginal gain.

**Paths** — `Paths.document`, matching §4.7's conclusion (Application Support was explicitly the *rejected* fallback there, and has no Android equivalent):

```
<Paths.document>/feast/audio/<talkId>.<rendition>.<ext>    ← rendition in the filename:
<Paths.document>/feast/transcripts/<talkId>.txt               cache_entries is keyed
<Paths.document>/feast/artwork/<talkId>.jpg                   (talk_id, rendition) and BOTH
                                                              can be .m4a — plain
                                                              <talkId>.<ext> collides
```

Backup exclusion covers `feast/` on both platforms (`plugins/with-backup-exclusion.ts`):
- **iOS:** `setResourceValue(true, forKey: .isExcludedFromBackupKey)` at first launch.
- **Android:** a `res/xml/backup_rules.xml` + `dataExtractionRules` exclusion for the directory, wired via `withAndroidManifest`.

#### LRU eviction

Run after every completed download and on app foreground.

```sql
SELECT talk_id, rendition, bytes, local_path
FROM cache_entries
WHERE pinned = 0
  AND state = 'complete'
  AND talk_id != :nowPlayingTalkId          -- never evict what's being read
ORDER BY COALESCE(NULLIF(last_played_at, 0), downloaded_at) ASC;
-- delete from the top until unpinned_bytes <= budget_bytes
```

Four rules the naive version gets wrong:

1. **`COALESCE(NULLIF(last_played_at,0), downloaded_at)`, not `last_played_at`.** A never-played download has `last_played_at = 0`, so a plain sort evicts it *first* — deleting exactly the smart-preloads and the "download for later" items the user just requested.
2. **Never evict the currently-playing talk.** A foreground-triggered sweep can otherwise delete the file being read.
3. **The budget covers unpinned bytes only.** Pinned is unbounded and reported separately — otherwise pinning a 1.1 GB collection against a 2 GB budget immediately evicts everything else. §15.11's bar must show them as two segments with only the cached segment measured against the budget.
4. **The disk figure sums all non-`pending` rows**, including `downloading` and `failed` — they occupy real bytes. Anything else drifts from `du` and breaks §19 criterion 15.

#### Reconciliation pass (on every cold start)

- `state='downloading'` ⇒ compare actual size to `content_length`; mismatch ⇒ delete the file, reset to `pending`. **Mandatory on Android** (§4.7: partial files survive a failed download); harmless on iOS.
- A file on disk with **no** `cache_entries` row ⇒ orphan from a crash ⇒ delete.
- A row with **no** file on disk ⇒ reset to `pending`.

Default budget **2 GB**, user-settable 500 MB – 50 GB. `Paths.availableDiskSpace` is checked before every download; refuse and warn below 1 GB free.

#### Download resume

A 130 MB download outlives a ~1-hour signed URL. On task failure the downloader re-mints via `getStreamUrl({ path })` and resumes with `Range: bytes=<bytesWritten>-`, appending to the partial file. Three attempts with backoff, then `state='failed'` and the `download-failed` flag, surfaced in Needs Attention.

### 11.4 Signed-URL expiry — the recovery path

Because OneDrive's expiry is undocumented and contradictory (§4.4), treat 403 as normal, not exceptional.

```ts
// on playbackStatusUpdate with status.error !== null
const pos = player.currentTime;
const wasPlaying = status.playing;

const net = await NetInfo.fetch();
if (!net.isConnected) return showOfflineBanner();   // don't burn a re-mint on being offline

const fresh = await storage.getStreamUrl({ path });  // re-resolve, never reuse

await player.replace({ uri: fresh.url });
// ⚠️ replace() resolving does NOT mean the source is loaded. Seeking now is dropped
// and playback silently restarts at 0:00. Wait for a status where the player reports
// loaded with a real duration, then seek.
await waitFor(() => player.isLoaded && player.duration > 0, { timeout: 10_000 });
await player.seekTo(pos);                            // replace() does NOT preserve position
if (wasPlaying) player.play();
```

**Policy — one rule, no exceptions:**

- **Mint on demand.** Never persist a `downloadUrl` to SQLite, MMKV, or `catalog.json`.
- **Pre-warm at most one item ahead, and no more than ~60 s before it's needed** — enough to cover cold-start latency without holding a URL long enough to expire. (An earlier draft's "pre-resolve the next 2–3 queue items when the queue is built" directly contradicts this; the mint-on-demand rule wins.)
- **No mid-playback pre-emptive refresh.** The only available mechanism is `replace` + re-buffer + seek, which is an audible stall. Instead: **for anything longer than 45 minutes, prefer download-then-play over streaming.** Do this automatically, and say so ("This lecture is 2h 14m — downloading first for smooth playback").
- Debounce; cap at 3 retries with backoff; distinguish 403-expiry from offline via NetInfo *before* re-minting.

**Downloaded talks sidestep every one of these problems.** Another argument for the cache.

### 11.5 Playback features

Speeds 0.8 / 1.0 / 1.2 / 1.5 / 1.75 / 2.0 / 2.5 / 3.0 with pitch correction. Skip ±15 s back / ±30 s forward (configurable). Sleep timer: 5/10/15/30/45/60 min + "end of talk", with a 20 s fade-out. Continuous play through a collection or series. Resume-anywhere with a "resume from 14:32?" prompt if the talk is >5 min in and >24 h stale. Auto-mark played at 95% or within 30 s of the end. Bookmarks with an optional note. Chapters where a series has parts.

---

## 12. Sync

Two directions, deliberately asymmetric.

### 12.1 Catalog (desktop → phone, one-way)

On app foreground (throttled to ≥15 min) and on manual pull-to-refresh:

1. `GET /Apps/Feast/catalog.json` with `If-None-Match: <stored etag>`.
2. `304` ⇒ done, zero cost.
3. **Version gate.**
   - `catalog.version > APP_MAX_VERSION` ⇒ "Update Feast to read this library." Apply nothing.
   - `catalog.version < APP_MIN_VERSION` ⇒ "Your desktop Feast is out of date — run `npm i -g feast` and re-import." Apply nothing.
   - In range ⇒ run `packages/core/src/catalogMigrations/<from>→<to>.ts` in sequence. **Every version bump ships a migration; there is no implicit upgrade.**
4. **Shrink guard.** If `counts.talks` dropped more than **5%** since the last sync and `allowShrink !== true`, refuse the whole sync and surface: *"The catalog lost 340 talks. This usually means OneDrive was still syncing when `feast import` ran. Nothing was changed."* This one check prevents the worst realistic data-loss scenario — a `feast import` over a partially-synced folder full of Files On-Demand placeholders.
5. Apply in one transaction:
   - Upsert `speakers`, `series`, `talks`, and all rows where `origin='catalog'`.
   - **Deletion authority is scoped by `origin`.** Catalog sync may only remove rows with `origin='catalog'`. Every collection, membership, and tag the user created on the phone survives every sync, *including* memberships they added to catalog-origin collections like "Greatest of All". Without this rule, using the multi-select organize workflow (§15.3) would silently erase the result on the next sync — which would gut requirement (d).
   - **Talks are never hard-deleted.** A talk absent from the catalog gets `missing_since = now` and is hidden from lists. Its ratings, bookmarks, and memberships remain intact. A talk that reappears clears the flag. Purging is manual, from Settings → Library, and warns about what it will remove.
   - **Apply `seedState` only for talk ids inserted in this transaction**, never for ids that already existed. Otherwise every sync would reset the user's listening progress.
6. Fetch any transcript shards whose ETag changed (Wi-Fi only, serial).

The app never writes `catalog.json`. Structural library changes flow only from ingest.

### 12.2 State (phone → OneDrive, write-behind)

Every mutation writes the domain table **and** an `outbox` row — carrying **only the changed fields** — in a single SQLite transaction. A flusher drains the outbox:
- on app background,
- every 60 s while foregrounded and dirty,
- via `expo-background-task@57.x` opportunistically.

```
flush():
  batch = SELECT * FROM outbox ORDER BY created_at        ← the CHANGE-SET, not a dirty flag
  if batch is empty: return
  next  = applyChangeSet(currentStateJson, batch)
  PUT state.json with If-Match: <stored etag>
    200 ⇒ DELETE the flushed outbox rows; store the new ETag
    412 ⇒ GET remote state.json
          merged = merge(remote, batch)                   ← per-field, using the change-set
          PUT merged with If-Match: <remote etag>; on success clear the batch
    5xx / network ⇒ increment attempts, exponential backoff, keep the rows
```

⚠️ **The flush must read the outbox payloads, not just re-serialize SQLite.** A 412 merge cannot be done correctly without knowing *which fields changed locally since the last successful PUT* — that information exists only in the outbox. Re-serializing the whole local state on 412 would clobber the other device's concurrent edits. If you find yourself ignoring `payload`, the outbox is dead weight and should be replaced by a `sync_meta` dirty flag instead — but then you have no correct 412 path, so don't.

Never PUT more often than every 30 s.

### 12.3 Playback position — the thing users notice

- Write to **MMKV every 1 s** while playing. It is a synchronous memory-mapped write; 1 Hz is effectively free, and it makes the resume guarantee tight rather than approximate.
- Flush MMKV → SQLite + outbox on pause, track change, `AppState` → background, and completion.
- **Never** write SQLite at that frequency.
- On cold start, reconcile MMKV → SQLite in case the app was killed mid-talk.

### 12.4 Merge rules

Generic LWW on `updated_at` — **except** for listen state, where LWW is wrong:

- `positionSec` → **`max()`** when neither side is completed (you got further on the other device).
- `played` → **monotonic**: `true` wins over `false`, always.
- `playCount` → `max()`.
- `rating`, `favorite`, `note` → LWW on `updated_at`.
- Collection membership → union; removals need an explicit tombstone (`deleted_at`), never an implicit absence. **This is why every syncable table in §6.2 carries `updated_at` / `deleted_at` / `device_id` and why none of them cascade.** Every read query filters `deleted_at IS NULL`.
- Collection ordering → **fractional index `orderKey`** via the `fractional-indexing` package (do not hand-roll it).
  ⚠️ Fractional indexes do **not** by themselves prevent collisions: two devices independently generating a key between the same neighbours produce *the same key*. That is a documented limitation of the technique. **Suffix every key with the `deviceId` (`"a0:dev1"`) and sort by `(order_key, talk_id)`** so ordering is total and deterministic. Rebalance the whole collection when any key exceeds 32 characters.

Encode this as a small domain-specific merge function. Do not reach for a generic CRDT library.

### 12.5 Sync-ready shape (for the multi-user future)

Adopt the shape now, the transport later: **UUIDv7 PKs generated client-side**; every syncable row carries `updated_at`, `deleted_at` (soft delete — never hard-delete a syncable row), and `device_id`; the outbox table above; a per-entity `sync_cursor`. If a framework is ever needed, **PowerSync** (`@powersync/react-native`) or **libSQL/Turso embedded replicas** (already reachable via `expo-sqlite`'s `useLibSQL` option) are the low-friction paths. None is needed now.

---

## 13. Search

**Local FTS5, always offline, no network.**

- Index: title, transcript, speaker name. `unicode61 remove_diacritics 2`. Query and ranking per §6.2.
- **Snippets:** `snippet(talks_fts, 1, '<b>', '</b>', '…', 24)` on the transcript column — showing *where in the talk* the phrase occurs is what makes a transcript index worth having.

⚠️ **Coverage is honest, not universal.** Until `feast transcribe` (§9.8) has run, only General Conference and BYU Speeches talks have transcripts. The Search screen shows a quiet footer: *"Searching titles and speakers across 1,875 talks, and inside 412 transcripts."* Never imply full coverage.

**Seeking to a transcript hit — how it actually works.** FTS5 has no offset API (FTS3/4's `offsets()` was removed, and `snippet()` returns rendered text, not a position). So:

1. Take the matched phrase and locate it in the **locally cached transcript** with `indexOf` — the app already has the full text, so no extra query is needed.
2. **Count words, not characters**, and strip non-spoken material first (title block, speaker attribution, footnote markers, references section) before computing the total.
3. Estimate `position ≈ (wordsBefore / spokenWords) × durationSec`, then **seek to `estimate − 20 s`**.
4. Offer a "next match" affordance so the user can step forward if the estimate lands early.

⚠️ **Be honest about the error.** Speaking rate varies far more than ±1.7%, so realistic accuracy is **±60–90 s on a 20-minute talk and ±2–4 minutes on a 2-hour lecture** — useful for "take me near it", not "take me to it". Word-accurate alignment requires a Whisper pass with timestamps and is **Phase 6**. Do not write an acceptance criterion that depends on tighter accuracy than this.

- Scoped search: "in this speaker", "in this collection", "in transcripts only".
- Filters as chips: speaker · role · collection · tag · rating · played/unplayed · downloaded · duration bucket · year range.
- Recent searches, saved searches (a saved search *is* a smart collection).

---

## 14. Design system

**Dark-first.** This app gets used at night, while driving, and while falling asleep. Light mode is a proper theme, not an afterthought, but dark is the default.

### 14.1 Color tokens

```ts
export const dark = {
  bg:        '#0D0F14',   // near-black, faint blue cast
  surface:   '#151922',
  surface2:  '#1E2430',
  border:    '#2A3140',
  text:      '#F2F4F8',
  textDim:   '#98A2B3',
  textFaint: '#5A6478',
  accent:    '#C9A227',   // brass/gold — reverent, warm, not garish
  accentDim: '#8A6F1B',
  accentSoft:'#2A2413',   // accent at 12% for chip backgrounds
  positive:  '#4A9B7F',   // downloaded / complete
  warning:   '#D89B4A',   // needs attention
  danger:    '#C4574B',   // evict / delete
  overlay:   'rgba(13,15,20,0.86)',
} as const;

export const light = {
  bg:        '#FAF8F4',   // warm parchment, not white
  surface:   '#FFFFFF',
  surface2:  '#F1EEE7',
  border:    '#E2DCD1',
  text:      '#1A1D24',
  textDim:   '#5A6478',
  textFaint: '#8A93A3',
  accent:    '#8A6F1B',
  accentDim: '#C9A227',
  accentSoft:'#F5EFDC',
  positive:  '#2F7A61',
  warning:   '#B87A28',
  danger:    '#A63F35',
  overlay:   'rgba(250,248,244,0.9)',
} as const;
```

**Accent discipline:** brass gold marks *the currently playing thing* and *the primary action*, nothing else. If everything is gold, nothing is.

### 14.2 Type

Two families. Serif for talk titles and speaker names — it earns the content a little gravity and distinguishes *content* from *chrome* at a glance. Sans for everything else.

| Token | Family | Size / Line | Weight | Use |
|---|---|---|---|---|
| `display` | serif | 32 / 38 | 600 | Player title, screen heroes |
| `title1` | serif | 24 / 30 | 600 | Screen titles |
| `title2` | serif | 19 / 25 | 600 | Talk titles in lists |
| `title3` | sans | 16 / 22 | 600 | Section headers |
| `body` | sans | 15 / 22 | 400 | Body |
| `bodyRead` | serif | 18 / 30 | 400 | **Transcript reader only** |
| `label` | sans | 13 / 18 | 500 | Metadata, speaker lines |
| `caption` | sans | 11 / 15 | 500 | Timestamps, sizes; `letterSpacing: 0.3` |
| `mono` | mono | 13 / 18 | 500 | Durations, byte counts — tabular figures |

Serif: **Source Serif 4** or **Newsreader** (both open, both excellent on screen). Sans: **Inter**. Mono: **JetBrains Mono**. Load via `expo-font`, subset to Latin.

### 14.3 Space, radius, motion

- Spacing scale: `4 · 8 · 12 · 16 · 24 · 32 · 48 · 64`. Screen gutter 16. Section gap 24.
- Radius: `sm 8 · md 12 · lg 16 · xl 24 · full 999`. Artwork `md`. Sheets `xl` (top corners only).
- Motion (Reanimated 4): standard 220 ms `cubic-bezier(0.2, 0, 0, 1)`; sheets 320 ms spring `{ damping: 22, stiffness: 220 }`; mini→full player is a **shared-element transition on the artwork** — drive it with Reanimated directly rather than a bottom sheet, for control over the feel. **Respect `prefers-reduced-motion`.**
- Touch targets ≥ 44×44 always. Player transport controls ≥ 64×64 (car and pocket use).

### 14.4 Iconography

One family, consistently: **Lucide** (`lucide-react-native`), 1.75 px stroke, 22 px default.
Semantic set — `play` `pause` `skip-back-15` `skip-forward-30` `list-music` (queue) · `download` (not cached) / `check-circle` (cached) / `pin` (pinned) · `bookmark` · `star` (rating) · `search` · `cloud` (stream-only) · `alert-circle` (needs attention).

### 14.5 The residency badge — a small component that carries the whole concept

Every talk row shows exactly one residency indicator. Users learn it in a day.

| Icon | Color | Meaning |
|---|---|---|
| ☁ hollow cloud | `textFaint` | In the catalog, not on this device. Tap to stream. |
| ⬤ filled dot | `positive` | Auto-cached. Plays offline. May be evicted. |
| 📌 pin | `accent` | Pinned. Guaranteed offline. |
| ⟳ ring progress | `accent` | Downloading. |
| ⚠ | `warning` | Needs attention (from `_Redownload`, or a failed/corrupt download). |

---

## 15. Screens

### 15.1 Onboarding (3 screens, ≤60 seconds)

1. **Welcome** — one sentence: *"Your whole gospel library, in your pocket, without filling your phone."* One button.
2. **Connect OneDrive** — explains plainly what access is requested and why ("read your Talks folder; store this app's settings in its own folder"). Launches `expo-auth-session` PKCE. On success, remembers forever (90-day rolling refresh).
3. **First sync** — pulls `catalog.json`. Progress with real counts read from `counts`, never hardcoded: *"1,875 talks · 34 speakers · 12 collections."* Ends on the promise, delivered as a **runtime-computed** number: **"Your library is 24.5 GB. Feast is using 2 MB."**

If no `catalog.json` exists: show setup instructions for `feast-ingest` with a copyable command and a "Check again" button. **Do not offer an in-app first scan** — that would mean shipping delta enumeration, filename parsing, and the §9.4 mapping table on-device, triggering exactly the throttling §4.4 warns about, to duplicate a tool that already exists. Instructions only.

### 15.2 Home

Vertical, scannable, no clutter.

```
┌─────────────────────────────────────────┐
│  Good evening                      ⚙︎   │
│                                          │
│  CONTINUE                                │
│  ┌────┬──────────────────────────────┐  │
│  │ ▤  │ Think Celestial!             │  │  ← large resume card
│  │    │ Russell M. Nelson            │  │
│  │    │ ▓▓▓▓▓▓▓░░░░░  14:32 / 21:40  │  │
│  └────┴──────────────────────────────┘  │
│                                          │
│  UP NEXT                       See all → │
│  ▸ horizontal cards                      │
│                                          │
│  PICK UP WHERE YOU LEFT OFF              │
│  ▸ started but unfinished                │
│                                          │
│  RECENTLY ADDED                See all → │
│  ▸ newest by importedAt                  │
│                                          │
│  FROM YOUR GREATEST OF ALL               │
│  ▸ shuffled from the 5-star collection   │
│                                          │
│  ⚠ 10 talks need re-downloading      →   │  ← only when non-empty
└─────────────────────────────────────────┘
```

The "Needs attention" strip is how `_Redownload` becomes actionable instead of a folder the user forgets about. It opens §15.14; "Queue re-download" writes a `jobs/<id>.json`.

### 15.3 Library

Segmented control across the top: **Speakers · Collections · Series · All Talks**. Remembers the last segment.

- **Speakers** — sectioned by role (Prophets first, ordered by `successionOrder`; then Apostles; then Others), each row with portrait, name, talk count, and an unplayed-count badge.
- **Collections** — grid of cards. User collections + smart ones (Unplayed, 5-Star, Downloaded, Recently Added, Longest, Shortest). Long-press → pin whole collection, with the size shown first.
- **Series** — the Lectures folders and multi-part sets, showing progress (`4 of 9 heard`).
- **All Talks** — FlashList over all ~2,000, with a sticky alpha index rail on the right and a sort control (title / speaker / duration / date added / recently played).

Every list supports **multi-select** (long-press to enter): add to collection, tag, pin/unpin, mark played/unplayed, add to queue, rate. **This is how the user re-creates the "move files between folders" workflow — and it's strictly better, because a talk can now be in two places at once.**

### 15.4 Speaker detail

Portrait header with a subtle gradient scrim, name, role, succession number for prophets, and stats (`117 talks · 42 heard · 31h 12m total`). Buttons: Play all · Shuffle · Pin all (with size). Then the talk list, groupable by year / series / alphabetical.

### 15.5 Collection detail — and the organize workflow

This screen and §15.5a are how requirement (d) is actually delivered. The data model has always supported nested collections; without this UI they are unreachable.

Header with description and totals. **Sub-collections render first**, as a compact row of folder chips, then the talks. A breadcrumb shows the parent chain (`Library › My List › Greatest of All`). **Reorderable** via drag (`react-native-gesture-handler` + Reanimated, writing fractional `orderKey`). Per-collection settings: pin, auto-play-next, sort mode. A "Pin this collection — 4.2 GB" row that turns into a progress bar during download.

Long-press a collection anywhere it appears → **Rename · Move to… · Change icon/color · Pin · Delete** (soft delete; "Deleted collections keep their talks — nothing is removed from your library").

### 15.5a Add-to-collection sheet

Reached from multi-select on any list, and from a talk's action row. A bottom sheet with:

- A search field over collection names.
- The **nested tree**, indented, with checkboxes. A talk can be checked into several at once — that's the whole point.
- **"＋ New collection"** at the top, which creates inline with a parent picker defaulting to the current context.
- Applying shows a one-line confirmation: *"Added to Greatest of All and Talks on Grace."*

Routes to add in §10: `app/collection/new.tsx`, `app/collection/[id]/edit.tsx`, `app/settings/tags.tsx`.

### 15.5b Series detail

Distinct from a collection: a series is intrinsic to the content and ordered by `partNumber`. Header shows the series name, presenter, part count, and **progress** (`4 of 9 heard`, with a thin bar). Talks are listed in part order with their numbers, not alphabetically. Buttons: Play from where I left off · Play all · Pin series (with size). Audiobook-kind series use chapter language and a single continuous resume position rather than per-part played flags.

### 15.6 Talk detail

Artwork or a generated gradient keyed to the speaker. Title (serif, large), speaker (tappable), event/session, date, duration, size, residency badge. Big Play. Row of secondary actions: Queue · Pin · Add to collection · Rate · Bookmark · Share.

Below: **the transcript**, in `bodyRead` serif at 18/30. Tap any paragraph to seek there. A "follow along" toggle auto-scrolls with playback. Collapsible. This turns a talk into something both listenable and studyable, and it's the feature that makes a gospel-study app different from a podcast app.

Then: bookmarks list, "more from this speaker", "others in this series".

### 15.7 Player (full screen)

```
┌─────────────────────────────────────────┐
│  ⌄                              ⋯       │
│                                          │
│         ┌──────────────────┐             │
│         │                  │             │
│         │     ARTWORK      │             │  large, rounded, soft shadow
│         │                  │             │
│         └──────────────────┘             │
│                                          │
│         Think Celestial!                 │  display serif
│         Russell M. Nelson                │  label, tappable, accent
│         October 2023 General Conference  │  caption
│                                          │
│   ──────────●───────────────────────     │  scrubber; buffered range dimmer
│   14:32                          -07:08  │  mono
│                                          │
│      ⏮      ⏪15    ▶︎ ⏸    ⏩30      ⏭   │  ≥64px targets
│                                          │
│   1.5×      ⏰ 30m     🔖      ☰ Queue   │
└─────────────────────────────────────────┘
```

Background: a very dark blur of the artwork, heavily desaturated — atmosphere without noise. Swipe down to dismiss to the mini player (shared-element artwork). Swipe left/right on the artwork = previous/next.

### 15.8 Mini player

Persistent 60 px bar above the tab bar. Artwork thumb, title (marquee only on overflow, once), play/pause, and a hairline progress line along the top edge. Tap = expand. Swipe up = expand. Swipe down = dismiss playback.

### 15.9 Queue

Bottom sheet (`@gorhom/bottom-sheet`). Now playing pinned at top, then Up Next, drag-to-reorder, swipe-to-remove, "Clear" and "Save as collection" — the latter turns an ad-hoc listening session into a permanent collection in one tap.

### 15.10 Search

Instant, local, sub-100 ms. Full-width field, filter chips beneath. Results grouped: **Talks · Speakers · Collections · In Transcripts**. Transcript hits show the bolded snippet with a timestamp; tapping plays from that point.

### 15.11 Downloads / Storage — *the screen that sells the concept*

```
┌─────────────────────────────────────────┐
│  Storage                                 │
│                                          │
│  ┌────────────────────────────────────┐ │
│  │████████░░░░░░░░░░░░░░░░░░░░░░░░░░░│ │  stacked bar
│  └────────────────────────────────────┘ │
│  ▓ Pinned 1.2 GB   (not counted against │
│                     the budget)          │
│  ▒ Cached 0.6 GB / 2.0 GB budget         │
│  41 GB free on device                    │
│                                          │
│  Library in the cloud: 24.5 GB · 1,875   │
│  On this device: 38 talks                │
│                                          │
│  [ Free up space ]   [ Change budget ]   │
│                                          │
│  PINNED                                  │
│  📌 Greatest of All  · 130 talks · 1.1GB│
│  📌 Think Celestial! · 21m · 18 MB      │
│                                          │
│  AUTO-CACHED           sorted by size ▾  │
│  ⬤ Righteous Warriors · 138 MB · swipe→ │
│  …                                       │
└─────────────────────────────────────────┘
```

Also here: Wi-Fi-only toggle, "prefer compact stream rendition" toggle, "clear all cached (keeps pinned)", and a plain-language line: *"Cached talks can be removed any time — they're always still in your library and one tap from playing again."*

### 15.12 Discover / Fetch

Hub with source cards: **General Conference · BYU Speeches · Podcast feed · Paste a link**.

Both browsers read the **source index** (§9.6a) out of the catalog folder, so browsing is instant and makes zero live requests to either publisher.

- **General Conference** — two entry points, and **the speaker one is the headline feature**, since "every talk by this person" is the user's actual ask:
  - **By speaker** → speaker list → every talk they've given, grouped by year, with checkboxes and "select all". *"Jeffrey R. Holland · 87 talks · 62 not in your library."*
  - **By conference** → year grid (1971→present) → sessions → talks.
- **BYU Speeches** — by speaker, or by recent; same selection model.
- Every selection screen shows a running total: *"48 talks · ~1.1 GB."* Confirm → writes `jobs/<jobId>.json`.
- **Job status** — pending/running/done with results read from `results/`, so a queued mass-download is visible and its outcome legible.

If the desktop tool isn't running, the UI says so plainly: *"Queued. Feast on your PC will fetch these next time it runs."* Never silently pend. If the source index is stale or missing: *"Run `feast index` on your PC to browse the back catalogue."*

### 15.13a First-run gate for automated fetching

Required by §20.1, and it must exist as a real screen before any General Conference fetch can be queued.

Shown once, the first time the user opens the General Conference source. Plain language, no legalese wall: what the Church's terms permit (personal downloading) and what they prohibit (automated access), what Feast does to be a good citizen (1 request/second, identifying User-Agent, personal archive only, never redistributed), and the alternatives (paste a link, use BYU's official podcast feeds, or write for permission — with a pre-filled draft email). Two buttons: **"I understand — enable"** and **"Keep this off."** The choice is stored and reversible in Settings → Sources. **Nothing is queued until it is made.** Off is the default.

### 15.14 Needs Attention

The cleanup surface for everything the import couldn't be sure about. Sections, each collapsible, each empty by default:

- **Needs re-downloading** (`needs-redownload`, from `My List/_Redownload`) → "Queue re-download" writes a job.
- **Unknown speaker** (`needs-attribution`) → tap to pick from the speaker list or create one.
- **Low-confidence titles** (`parseConfidence < 0.7`) → inline edit of title / speaker / series / part number.
- **Failed downloads** (`download-failed`) → retry or clear.
- **Unplayable format** (`unplayable-format`, e.g. the `.wma`) → "Queue conversion".
- **Missing files** (`missing_since` set) → "These are in your library but not in OneDrive. Re-run `feast import`, or remove them."

Edits here write to `state.json` as user overrides and are re-applied after every catalog sync, so a later `feast import` never undoes the user's corrections.

### 15.13 Settings

Account (connected Microsoft account, library root, sign out) · Playback (speed, skip intervals, auto-play next, resume threshold, mark-played threshold) · Downloads (budget, Wi-Fi only, preload count, rendition preference) · Appearance (dark/light/system, text size) · Library (needs-attention list, speaker alias editor, re-import) · About + diagnostics (last sync, catalog version, throttling log).

---

## 16. Interaction details that matter

- **Every list row:** tap = play (or open detail — pick one and be consistent; **recommend: tap = open detail, tap the artwork = play**). Long-press = multi-select. Swipe right = queue next. Swipe left = pin/unpin.
- **Haptics** (`expo-haptics`): light on selection, medium on pin/unpin, success on download complete, warning on eviction. Nothing on scroll.
- **Empty states** are instructions, never shrugs. Empty queue: "Nothing up next. Add talks by swiping right on any row."
- **Errors are honest and actionable.** Not "Playback failed" but "Couldn't reach OneDrive. This talk isn't downloaded — try again on Wi-Fi, or pin it for later." Include a retry.
- **Throttling is surfaced, not hidden.** If Graph returns `Retry-After`, show "Syncing paused, resuming in 5 min" rather than spinning silently.
- **Accessibility:** every control labeled; the scrubber is an `adjustable` accessibility role with 15 s increments; Dynamic Type respected up to XXL without breaking layouts; contrast ≥ 4.5:1 for text and ≥ 3:1 for the residency badges; VoiceOver announces residency state in the row label ("Think Celestial, Russell M. Nelson, 21 minutes, downloaded").

---

## 17. Performance targets

| | Target |
|---|---|
| Cold start → interactive Home | < 1.2 s |
| Library list scroll | 60 fps at 2,000 items (FlashList v2 + memoized rows) |
| Search keystroke → results | < 100 ms (FTS5, debounced 120 ms) |
| Tap play (cached) | < 150 ms to audio |
| Tap play (stream) | < 1.5 s to audio (1 Graph call + first range) |
| Catalog sync (unchanged) | < 300 ms (304 Not Modified) |
| Catalog sync (2,000 talks changed) | < 5 s |
| Memory, library browsing | < 220 MB |

Rules: query only what's on screen (`useLiveQuery` over keyset-paginated Drizzle queries — never load 2,000 rows into JS); memoize every row component; `expo-image` with `recyclingKey`; generate gradient placeholders from the speaker id rather than shipping 34 portraits at full size.

---

## 18. Build phases

**Ship each phase working, on a real device, with real files, before starting the next.**

### Phase 1 — Skeleton + read-only playback (the riskiest 20%, done first)
- Monorepo, `packages/core` types, SQLite + Drizzle + migrations.
- `expo-auth-session` PKCE against `consumers`, tokens in `expo-secure-store`, silent refresh.
- `OneDriveProvider` implementing the full `StorageProvider` interface — **including the §7.1 path→ID resolution with the path-addressing fallback.** Phase 1 is the *only* phase where this can be validated cheaply; every later phase depends on it.
- `PlayerService` on `expo-audio` + JS queue + lock-screen metadata.
- **The 403 → re-mint → await-load → seek recovery path (§11.4).** It belongs here, not Phase 3: Phase 1 already streams 2-hour lectures over URLs that expire in ~1 hour.
- A single hardcoded list of talks from the drive; tap to stream; background audio works; lock screen works.
- **Exit criteria:** (a) play a talk from OneDrive on a locked iPhone *and* a locked Android phone with working lock-screen seek controls; (b) seek to the middle of a 130 MB file in under 3 s; (c) **resolve a logical path like `Talks/By Speaker/…/x.mp3` to playing audio in exactly one Graph round trip on a warm cache**; (d) survive a forced URL expiry without losing position.

### Phase 2 — Ingest + real catalog
- `feast login`, `init`, `import`, `doctor`, `dedupe`. Content hashing, artwork extraction, filename parsing, the §9.4 mapping table with §9.3 conflict rules, speaker canonicalization.
- `catalog.json` + transcript shards + `seedState`; app-side sync with ETag, the version gate, the shrink guard, and `origin`-scoped deletion.
- Library / Speakers / Series / Collections / Talk detail screens.
- **Exit criterion: the app shows all ~1,875 deduped talks, correctly attributed, with ratings and played-state derived from the folder names, and reports the reclaimable duplicate bytes — and a second `feast import` + sync changes nothing the user has since edited on the phone.**

### Phase 3 — Cache + storage control
- `CacheManager`, dual-fetch with Wi-Fi gating, LRU with the four §11.3 rules, pinning, the startup reconciliation pass, download resume, the backup-exclusion plugin (iOS + Android).
- Storage screen, budget, preload.
- **Exit criterion: airplane mode → a pinned collection plays flawlessly; the storage bar matches `du` on the device to within 1%; killing the app mid-download leaves no corrupt file.**

### Phase 4 — State, search, organization
- Listen state, ratings, bookmarks, notes; MMKV → SQLite → outbox → `state.json`, with a real 412 merge.
- FTS5 + transcript shard prefetch + snippet search + approximate seek-to-hit.
- Multi-select, the add-to-collection sheet, nested collection management, drag reorder, smart collections.
- Transcript reader. Needs Attention.
- **Exit criterion: full-text search over all titles and speakers plus every available transcript returns in under 100 ms in airplane mode; adding a talk to a catalog-origin collection survives a catalog re-sync.**
  ⚠️ *Full* transcript coverage is not a Phase 4 gate — it depends on `feast transcribe` (§9.8), which ships in Phase 5.

### Phase 5 — Acquisition
- `SourceAdapter`s for General Conference, BYU Speeches, Omny RSS, generic RSS, direct URL.
- `feast index` (the source index, §9.6a) — **this is what makes by-speaker fetching possible.**
- `feast fetch` (incl. `gc --speaker` and `byu --speaker`) + `feast jobs --watch` + service install.
- The in-app Discover UI, the §15.13a consent gate, and job status from `results/`.
- `feast transcode` (HE-AAC v2) and the dual-rendition playback preference. `feast transcribe`.
- **Exit criterion: from the phone, select "every General Conference talk by Jeffrey R. Holland", and after the desktop tool runs those talks are in the library, correctly filed, with transcripts.**

### Phase 6 — Polish and stretch
PDF/Books reader · Android Auto (needs a browse-tree solution — see §4.9) · CarPlay (entitlement first) · widgets · Siri/Google shortcuts · Whisper alignment for word-accurate transcript seeking · a second device and real bidirectional state merge.

---

## 19. Acceptance criteria

The build is done when **all** of these are true on a real device with the real 24.5 GB library:

1. The app installs and, after one Microsoft sign-in, shows every talk in the catalog — **using under 50 MB of library data** (catalog + transcripts + database, excluding the app binary and any cached audio). The number shown on the sync screen is computed at runtime, not hardcoded.
2. Every talk plays. Seeking to the middle of a 130 MB lecture takes < 3 s.
3. Audio continues with the screen locked, the app backgrounded, over Bluetooth, and through a headphone disconnect (which pauses).
4. Lock-screen controls show title, speaker, artwork, and working **seek** buttons on both platforms.
   ⚠️ Not next/previous track: §4.2 establishes that `expo-audio` exposes only `showSeekForward`/`showSeekBackward` and surfaces no remote-command events to JS. The JS queue advances on `onEnded` only.
5. `_Greatest of All` appears as a collection **and** as a 5-star rating; `_Listened To` talks are marked played; `_To be Seen` is in the queue; `_Redownload` items are flagged in Needs Attention. All of it arrives via `catalog.json`'s `seedState`, applied once.
6. The Bytheway lecture that exists in two folders appears **once**, in both collections, and `feast dedupe` reports the reclaimable bytes.
7. Pinning "Greatest of All" downloads 130 talks with accurate progress, and they all play in airplane mode.
8. Auto-cache respects the budget and evicts LRU without ever evicting a pinned item, the currently-playing talk, or a just-downloaded-never-played item ahead of an older played one.
9. Search over titles, speakers, and every available transcript returns in < 100 ms offline. A transcript hit seeks into the right region of the talk and offers "next match".
   ⚠️ Not "within 20 seconds" — §13 explains why that accuracy needs Phase 6 alignment.
10. Playback position survives force-quit and resumes **within 1 second** of where it stopped.
11. Selecting "all talks by <speaker>" in Discover results in those talks being in the library after the desktop tool runs.
12. Killing the network mid-playback of a *cached* talk changes nothing.
13. Killing the network mid-playback of a *streamed* talk shows an honest error with a retry that works.
14. An expired signed URL recovers automatically, resuming within 2 s at the same position.
15. Storage screen figures match actual disk usage to within 1%.
16. Adding a talk to a catalog-origin collection on the phone, then running `feast import` and re-syncing, **leaves that membership intact.** Same for tags, ratings, and bookmarks.
17. A `catalog.json` with 10% fewer talks is **refused**, with an explanatory message, and nothing is deleted.
18. **No Microsoft Graph type import and no raw Graph URL appears anywhere outside `packages/storage/`.** (`apps/ingest` legitimately *uses* `OneDriveProvider`; it just may not reach past it.)
19. General Conference fetching is off until the user passes the §15.13a consent screen.

---

## 20. Risks, constraints, and honest caveats

### 20.1 ⚠️ Terms of Use — read before building the fetcher

This is the most important non-technical constraint in the document, and it needs a deliberate decision rather than a default.

**churchofjesuschrist.org** permits personal downloading and prohibits automated access, simultaneously:

> ✅ *"view, download, and print materials from this site for your own personal, noncommercial use."*
> ⛔ *"use any robot, spider, or other automatic device, process, or means to access this site for any purpose, including, without limitation, for monitoring or copying any of the material on this site."*

So the *content* is downloadable for personal use; the *automation* is not permitted by the terms, regardless of how personal the use is. That's a terms question, not a technical one, and it can't be engineered away.

**Recommended posture — implement all of it:**

1. **Treat General Conference fetching as opt-in and explicit.** Ship it disabled, behind a one-time screen that states the terms plainly and requires an affirmative choice. Do not make it the default path.
2. **Never bundle, cache-share, or redistribute any fetched content.** Everything lands in the user's own OneDrive, for the user only.
3. **Rate-limit hard and identify honestly.** Concurrency 1, ≥1,000 ms between requests, real `User-Agent` with a contact address, conditional requests so re-runs cost nothing, and a hard daily request ceiling.
4. **Prefer official feeds wherever they exist.** For BYU Speeches, the Omny podcast feeds are the publisher's intended subscription mechanism — use them by default and treat the WP REST API as the fallback for back-catalog.
5. **Ship a first-class manual path**: paste a URL, drop a file, import a folder. The app must be fully useful with the automated fetchers switched off. This matters — it means the ToS question never blocks the core product.
6. **Suggest writing to the Church's rights office** for explicit permission for a personal archive tool. Costs an email; may resolve it outright.

**speeches.byu.edu** publishes no terms page, no explicit personal-use grant, and no anti-robot clause. Footer: `"© 2026 All rights reserved."` Absence of a prohibition is not permission. Same posture: polite rate limits, personal use only, prefer the Omny feeds. Contact `speeches@byu.edu`.

**And regardless of source: this is a personal archive.** No redistribution, no sharing of fetched audio, no public hosting of the catalog. Several architectural choices in this document (OneDrive as backend, no server, single user) only stay defensible while that holds.

### 20.2 Technical risks

| Risk | Severity | Mitigation |
|---|---|---|
| Signed URL expires mid-playback | 🔴 High | §11.4 — re-resolve on 403, await load, restore position. Never persist URLs. Never point the player at `/content`. |
| **Catalog sync destroying user curation** | 🔴 High | `origin` scoping on deletes, soft-delete talks via `missing_since`, the 5% shrink guard, seed-state applied once. §12.1 |
| Graph throttling on enumeration | 🔴 High | Enumeration happens **only in ingest, on the desktop**. The app resolves single paths (§7.1). Concurrency ≤3, persist deltaLink, honour `Retry-After`, no user-facing full-rescan button. §4.4 |
| Undocumented, dynamic Graph limits | 🟠 Med | Architectural — unfixable. Degrade gracefully and tell the user the truth. |
| Android partial downloads | 🟠 Med | `content_length` verification in the startup reconciliation pass. §11.3 |
| iOS/Android backup-exclusion | 🟠 Med | The config plugin in Phase 3 — covers `NSURLIsExcludedFromBackupKey` *and* Android `dataExtractionRules`. §11.3 |
| No CDN in front of OneDrive | 🟠 Med | Aggressive on-device caching — which is the right mobile design anyway. |
| Cold-start latency per stream | 🟡 Low | Pre-warm **one** item ahead, ≤60 s before it's needed. §11.4 — never more, or the URL expires in hand. |
| Long lecture outlives its URL | 🟡 Low | Auto-download-before-play above 45 min. §11.4 |
| Catalog JSON grows unwieldy | 🟡 Low | Transcripts sharded to NDJSON from day one (§6.3). Metadata alone is ~2 MB at this scale; revisit past ~10k talks. |
| Android Auto needs a browse tree | 🟡 Low | Known and scoped to Phase 6. §4.9 |
| Refresh token revoked | 🟡 Low | Handle `invalid_grant` with an interactive re-prompt. Cheap to get right. |
| Consumer OneDrive API quirks | 🟡 Low | Defensive parsing; don't trust `childCount`; handle duplicate delta entries. |

### 20.3 Things deliberately not built

No server. No accounts. No social features. No in-app editing of audio. No DRM. No analytics. No ads. No AI summarization in v1 (tempting, and a good Phase 6 candidate once transcripts are indexed).

---

## 21. Open questions for the user

Answer these before Phase 2; none block Phase 1.

1. **Library root** — is `Talks/` the whole scope for v1, or should `Podcasts/`, `Books/Audio Books/`, and `Books/PDF Books/` be in from the start? (Recommended: Talks in Phase 2, Podcasts in Phase 5, Books in Phase 6.)
2. **Dedup** — after review, actually remove the redundant file copies to reclaim ~1 GB, or keep every copy on disk and just unify them in the app? (Recommended: review-then-reclaim, with copies moved to `_deduped/` rather than deleted.)
3. **Transcode** — build compact stream renditions? Takes the streaming footprint from 24.5 GB to **~6 GB** (not the 3.5 GB an earlier draft claimed) and makes "pin a whole speaker" realistic. Costs a one-time multi-hour ffmpeg run.
4. **Transcription** — run `feast transcribe` over the archive? It's the only way the ~1,460 non-publisher talks become searchable inside, but it's a multi-day background job on CPU. (Recommended: yes, overnight, incrementally — search over titles and speakers works from day one regardless.)
5. **General Conference fetching** — given §20.1, enable it with the polite-fetch discipline, rely on manual/BYU paths, or write for permission first?
6. **Distribution** — sideload / TestFlight / personal Play Console track, or actually publish? This changes the CarPlay and Play-review conversations substantially. (Recommended: TestFlight + Play internal testing. No store review, no ToS exposure, installs on his own devices.)
7. **Speaker portraits** — source them, or ship generated gradient monograms? (Recommended: gradients in v1 — `Speaker.gradientSeed` is already in the model; they look intentional and ship instantly.)

---

## Appendix A — Reference links

**Expo / RN:** [expo-audio](https://docs.expo.dev/versions/latest/sdk/audio/) · [expo-audio plugin source](https://github.com/expo/expo/blob/sdk-57/packages/expo-audio/plugin/src/withAudio.ts) · [expo-file-system](https://docs.expo.dev/versions/latest/sdk/filesystem/) · [expo-sqlite](https://docs.expo.dev/versions/latest/sdk/sqlite/) · [New Architecture](https://docs.expo.dev/guides/new-architecture/) · [SDK 57 changelog](https://expo.dev/changelog/sdk-57) · [Expo authentication](https://docs.expo.dev/guides/authentication/) · [FlashList v2](https://shopify.engineering/flashlist-v2)

**Microsoft Graph:** [driveItem](https://learn.microsoft.com/en-us/graph/api/resources/driveitem?view=graph-rest-1.0) · [get content](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0) · [delta](https://learn.microsoft.com/en-us/graph/api/driveitem-delta) · [audio facet](https://learn.microsoft.com/en-us/graph/api/resources/audio?view=graph-rest-1.0) · [special folder](https://learn.microsoft.com/en-us/graph/api/drive-get-specialfolder?view=graph-rest-1.0) · [permissions](https://learn.microsoft.com/en-us/graph/permissions-reference) · [auth code + PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow) · [refresh tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens) · [throttling](https://learn.microsoft.com/en-us/graph/throttling) · [downloadUrl expiry issue #884](https://github.com/OneDrive/onedrive-api-docs/issues/884)

**Android:** [FGS types (14)](https://developer.android.com/about/versions/14/changes/fgs-types-required) · [FGS changes (15)](https://developer.android.com/about/versions/15/changes/foreground-service-types) · [Play target SDK](https://developer.android.com/google/play/requirements/target-sdk)

**Sources:** [Church rights and use](https://newsroom.churchofjesuschrist.org/rights-and-use) · [Church terms of use](https://www.churchofjesuschrist.org/legal/terms-of-use?lang=eng) · [BYU Speeches](https://speeches.byu.edu/) · [BYU Speeches podcasts](https://speeches.byu.edu/podcasts) · [spig/gc-audio](https://github.com/spig/gc-audio)

**Storage pricing:** [Cloudflare R2](https://developers.cloudflare.com/r2/pricing/) · [Backblaze B2](https://www.backblaze.com/cloud-storage/pricing) · [AWS S3](https://aws.amazon.com/s3/pricing/)

**Car:** [@g4rb4g3/react-native-carplay](https://www.npmjs.com/package/@g4rb4g3/react-native-carplay) · [Expo CarPlay/Auto discussion](https://github.com/expo/expo/discussions/24354)

---

## Appendix B — First prompt for Claude Code

Paste this alongside the spec to start:

> Read `FEAST-SPEC.md` in full before writing any code.
>
> Build **Phase 1** only (§18). Set up the pnpm monorepo per §5, implement `packages/core` types from §6.0–6.1, the `StorageProvider` interface from §7.2, and `OneDriveProvider` against the verified Graph behavior in §4.4 — **including the §7.1 path→ID resolution with the path-addressing fallback.** Then build the Expo SDK 57 app shell with `expo-audio` playback per §4.2–4.3 and §11.1, and the §11.4 URL-expiry recovery.
>
> Constraints:
> - Use the exact package versions in §4.8. Verify each with `npx expo install --check` before committing; if a version has moved, tell me rather than guessing.
> - `packages/storage/` is the only place a Microsoft Graph type or raw Graph URL may appear.
> - Do not use `react-native-track-player` or `useAudioPlaylist` — §4.2 explains why.
> - Never point the audio player at `/content`; resolve `@microsoft.graph.downloadUrl` and pass the bare URL. §4.4.
> - `replace()` resolving is not the same as the source being loaded — always await a loaded status before `seekTo`. §11.4.
>
> Stop at the Phase 1 exit criteria (all four) and show me how to run it on a device. Ask before deviating from the spec on anything in §4, §6, §7, or §12.

---

## Appendix C — Revision notes

**v1.1** applied 20 defects found in an adversarial review of v1.0. The nine that would have blocked a build:

| # | What was broken | Now |
|---|---|---|
| 1 | The app held logical paths; `StorageProvider` demanded driveItem IDs. **Playback was impossible.** | §7.1 — `StorageRef`, provider-owned path→ID map, path-addressing fallback |
| 2 | `Series` was navigated in three screens but had no entity, table, or catalog field | §6.1 `Series`, §6.2 `series` table, §6.3 array, §15.5b screen |
| 3 | Imported played-state and ratings had no channel from ingest to app | §6.3 `seedState`, applied once on insert |
| 4 | Catalog sync deleted phone-created curation and cascade-deleted ratings | §12.1 `origin` scoping, `missing_since` soft delete, 5% shrink guard, no cascades |
| 5 | The FTS5 table referenced a column that doesn't exist and mapped on an unstable rowid | §6.2 explicit `rowid`, denormalized `speaker_name`, full trigger set |
| 6 | Transcode math was ~1.7× optimistic, and Opus doesn't decode on iOS | §2 — ~6.1 GB, HE-AAC v2 in `.m4a` |
| 7 | Per-talk transcript files were the exact throttling anti-pattern §4.4 forbids | §6.3 NDJSON shards |
| 8 | "No Graph writes" contradicted twice; CLI had no auth; `jobs.json` had two writers | §9 split transports, §9.0 `feast login`, §6.3 one-writer-per-file |
| 9 | Artwork promised in five places, absent from the data model | §6.1 `artworkPath`/`artworkColor`, §9.2 extraction at import |

Plus: LRU evicting fresh downloads first, unguarded cellular downloads, `seekTo` racing `replace()`, no speaker-centric fetch path for either source, missing tombstones, two incompatible `contentHash` definitions, an unreachable nested-collections UI, an outbox that was never read, and no transcript source for 1,460 of the talks.

---

*Spec version 1.1 · 13 August 2026 · §4 is verified against live sources, not remembered. §6, §7, §11, and §12 were revised after adversarial review — the ⚠️ markers in those sections flag things that were actually wrong once, and will be again if you "simplify" them.*
