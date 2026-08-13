# Feast

**A personal gospel-audio library: cloud-resident, pocket-cached, infinitely expandable.**

The phone holds a few megabytes of metadata describing everything, streams or caches
audio on demand, and lets one talk belong to as many collections as it deserves — while
a desktop companion mass-fetches new talks straight into the archive.

Built to `docs/FEAST-SPEC.md`. Section references throughout the code (`§4.4`, `§11.3`)
point at that document; the ⚠️ markers in it flag things that were actually wrong once.

---

## What exists today

**Phase 1 is implemented** (spec §18), plus the design system and screen shells that
Phases 2–4 will fill in.

| Package | State |
|---|---|
| `packages/core` | Complete for Phases 1–2. Entity types (§6.1), the ISO↔epoch date codec (§6.0), zod wire schemas for `catalog.json` / `state.json` / jobs / results (§6.3), speaker canonicalization with the four-tier match (§9.4), filename parsing (§9.5), UUIDv7. Zero runtime deps beyond `zod`. |
| `packages/storage` | Complete. `StorageProvider` (§7.2) and `OneDriveProvider` — path→id map with path-addressing fallback (§7.1), Graph client capped at concurrency 3 with exact `Retry-After` handling (§4.4), `/delta` with 410-recovery and last-occurrence-wins, ETag-guarded app-file reads and writes. |
| `apps/mobile` | Phase 1. PKCE auth against `/consumers`, SQLite + FTS5 schema (§6.2), `PlayerService` over `expo-audio` with the §11.4 expiry-recovery path, JS queue, MMKV position persistence (§12.3), and the Home / Library / Search / Storage / Player / Talk-detail screens against the §14 design system. |
| `apps/ingest` | **Not built.** This is Phase 2 (§18) and the spec is explicit that Phase 1 must work end to end on a real device with real files first. |

Everything typechecks (`pnpm typecheck`) and `expo install --check` reports the SDK 57
pins clean. **Nothing has been run on a device** — see "Before it will run", below.

---

## Before it will run

Two things are required and neither can be done from the repo.

### 1. Microsoft app registration

The app needs a free Entra app registration. In the
[Azure portal](https://portal.azure.com) → **App registrations** → **New registration**:

- **Supported account types:** *Personal Microsoft accounts only*.
- **Redirect URI:** add a platform → **Mobile and desktop applications** → *Custom URI* →
  `feast://auth`.
  Also add `http://localhost` for the future `feast login` CLI (§9.0).

> ⚠️ **Register it under "Mobile and desktop applications", NOT "Single-page
> application"** (§4.4). An `spa`-typed redirect silently caps refresh tokens at
> **24 hours**, turning a sign-in-once app into a sign-in-daily one. The symptom
> appears a day after you ship, which is a miserable time to discover it.

No client secret — this is a public client using PKCE. Then:

```bash
cp .env.example .env.local
```

and put the Application (client) ID in `EXPO_PUBLIC_MS_CLIENT_ID`.

### 2. A native build

Feast is installed as a signed release APK, not through Expo Go — FTS5 is enabled via
the `expo-sqlite` config plugin (§4.6), so Expo Go fails at launch with
`no such module: fts5`.

Day-to-day updating is [`docs/UPDATING.md`](docs/UPDATING.md): bump `VERSION_CODE`, run
`publish-update.bat`, then press **Settings → Updates** on the phone. No cable.

⚠️ **Back up `apps/mobile/feast-release.jks` and `keystore.properties` now.** They are
gitignored and there is no recovery path — losing them means no future build can ever
update the installed app without an uninstall, which deletes the library database.

<details>
<summary>Building from a fresh clone</summary>

Restore `keystore.properties` and `feast-release.jks` into `apps/mobile/` first —
without them the build falls back to a debug key and cannot update an existing install.

```bash
pnpm install
```

Then, from the repo root:

```bash
update.bat
```

For JS-only iteration against a running dev build:

```bash
pnpm mobile
```

</details>

---

## Validating Phase 1 on a device

The spec's Phase 1 exit criteria are four specific things (§18). Since `feast-ingest`
does not exist yet, there is no catalog — so Home shows the setup instructions and a
link to **Browse OneDrive directly** (`app/dev-browse.tsx`), the Phase 1 harness. It
lists one folder and streams from it, writing nothing to the database.

| Criterion | How to check |
|---|---|
| (a) Plays on a **locked** iPhone *and* a locked Android phone, with working lock-screen **seek** | Start a talk, lock the phone, wait past 3 minutes on Android (that is the `setActiveForLockScreen` threshold, §4.2). Lock screen shows seek, not next/previous — §4.2 explains why that is a platform limit, not an omission. |
| (b) Seek to the middle of a 130 MB file in under 3 s | Any Education Week lecture. Range requests work on the signed URL (§4.4). |
| (c) Logical path → playing audio in **one** Graph round trip on a warm cache | Play a talk, then play it again. The second play hits the persisted path→id map (§7.1 step 1). |
| (d) Survive a forced URL expiry without losing position | Play, wait ~1 hour, or force it: the recovery path is `re-mint → await loaded → seek → resume` in `src/player/store.ts`. |

---

## Layout

```
packages/core/       Shared types and pure logic. NO I/O.
packages/storage/    StorageProvider + OneDriveProvider.
                     ⚠️ THE ONLY place a Microsoft Graph type may appear (§7.2 rule 1).
apps/mobile/         The Expo app.
apps/ingest/         Phase 2. Not built yet.
docs/                The spec.
```

The boundary rule in `packages/storage` is the most important one in the repo and it is
acceptance criterion 18. Everything above it addresses content by **logical path**
(`Talks/By Speaker/Prophets/17 Russell M. Nelson/x.mp3`), never by driveItem id. Honour
that and migrating to B2/R2 is one new file plus a re-index, with every collection,
rating, and bookmark surviving untouched.

---

## Decisions taken, and why

Four places where the build departed from the spec, or had to choose where the spec
was silent or self-contradictory. Each is one line to change back.

**1. `catalog.json` lives at `approot:/catalog.json`, not `approot:/feast/catalog.json`.**
§6.3 lays the app documents out at `/Apps/Feast/catalog.json`; §4.4's example URL is
`approot:/feast/catalog.json`, which would put them at `/Apps/Feast/feast/…`. §6.3 is
the layout section and is used consistently everywhere else, so it wins. The choice is
the single constant `APP_FOLDER_PREFIX` in `packages/storage/src/onedrive/OneDriveProvider.ts`.

**2. No NativeWind.** §4.8 lists it at 4.2.6. §14 defines a *token* system — nine type
tokens, one accent rule, one spacing scale — and expressing that as typed props catches
"title2 but 17px" at compile time in a way class strings do not, without a Tailwind
config and a Metro/Babel transform in the way. `src/ui/tokens.ts` + `primitives.tsx` is
the whole styling layer. Adding NativeWind later is additive.

**3. Migrations are hand-written SQL, not drizzle-kit output.** §4.6 states Drizzle
cannot model FTS5 virtual tables, and the FTS5 setup is not incidental — the external
content table, the explicit `rowid`, and the three triggers were each wrong once
(Appendix C, defect 5). `src/db/migrations.ts` transcribes §6.2 verbatim so it stays
reviewable against the spec; `src/db/schema.ts` gives Drizzle's typed queries over the
same tables.

**4. `readAppFile` takes an optional `ifNoneMatch`.** §12.1 requires a conditional
catalog read whose 304 costs nothing, which the §7.2 signature has no way to express.
It is an additive optional parameter; a provider that ignores it still satisfies the
interface.

Two version corrections against §4.8, both confirmed from Expo's live SDK 57 manifest:
`app.config.ts` carries no `newArchEnabled` and no top-level `splash` key, because SDK
57 removed both from the config type — the first for exactly the reason §4.1 gives.

---

## Open questions (spec §21)

None of these block Phase 1; all of them shape Phase 2.

1. **Library root** — is `Talks/` the whole scope for v1, or are `Podcasts/`,
   `Books/Audio Books/` and `Books/PDF Books/` in from the start?
2. **Dedup** — after review, actually reclaim the ~1 GB of duplicate copies, or unify
   them in the app only?
3. **Transcode** — build the compact HE-AAC v2 stream renditions (24.5 GB → ~6 GB)?
4. **Transcription** — run `feast transcribe` over the archive? It is the only way the
   ~1,460 non-publisher talks become searchable inside.
5. **General Conference fetching** — §20.1's terms question. Enable with the polite-fetch
   discipline, rely on manual/BYU paths, or write for permission first?
6. **Distribution** — TestFlight + Play internal testing, or actually publish?
7. **Speaker portraits** — source them, or ship the generated gradients? (They are
   already implemented, seeded from `Speaker.gradientSeed`.)

One practical note for Phase 2: **the `Talks/` archive is not in the local OneDrive
folder on this machine.** `feast import` reads the *local* synced folder by design
(§9.2) — 24 GB through Graph would be absurd — so it needs to run on the PC where that
folder actually lives, or the folder needs syncing here first.
