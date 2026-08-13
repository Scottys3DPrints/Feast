/**
 * The StorageProvider contract — SPEC §7.2.
 *
 * Every candidate backend converges on one primitive: "give me a time-limited,
 * auth-free, Range-capable URL." OneDrive calls it `@microsoft.graph.downloadUrl`;
 * S3/R2/B2 call it a presigned GET. Build around that and the player never learns
 * the difference.
 *
 * FOUR RULES (§7.2). Breaking any of them makes the eventual backend swap expensive:
 *
 *   1. Never let a provider-specific ID escape this package. Nothing outside
 *      `packages/storage/` may store, log, or serialize a driveItem ID. Everything
 *      above addresses content by logical `path`, with `contentHash` as identity.
 *   2. Treat `expiresAt` as advisory. The §11.4 recovery path must work regardless.
 *   3. Push ID3 parsing behind the provider. OneDrive fills `audio` free; object
 *      stores range-read the first ~256 KB at index time. Same StorageItem either way.
 *   4. Keep the manifest format provider-neutral JSON.
 */

/** ID3/MP4 tags. OneDrive Personal extracts these server-side — see §4.4 `audio` facet. */
export interface AudioTags {
  album?: string;
  albumArtist?: string;
  artist?: string;
  bitrate?: number;
  composers?: string;
  copyright?: string;
  disc?: number;
  /** Milliseconds. */
  duration?: number;
  genre?: string;
  hasDrm?: boolean;
  isVariableBitrate?: boolean;
  title?: string;
  track?: number;
  year?: number;
}

export interface StorageItem {
  /** Provider-specific and OPAQUE (driveItem id | object key). Must not escape. */
  id: string;
  /** Provider-NEUTRAL logical path — "Talks/By Speaker/…/x.mp3". */
  path: string;
  name: string;
  size: number;
  /**
   * §6.0 — provider-reported (OneDrive quickXorHash/sha1, S3 ETag, B2 sha1).
   * NOT the dedup key, and never compared against `Talk.contentHash`.
   */
  providerHash?: string;
  modifiedAt: string;
  audio?: AudioTags;
  /** True for folders. The catalog only ever stores files. */
  isFolder?: boolean;
}

export interface SignedUrl {
  /** NO auth headers required — and you must not send any (§4.4). */
  url: string;
  /**
   * Epoch ms. ADVISORY ONLY: OneDrive's expiry is undocumented and the docs
   * contradict themselves (1 hour vs "might expire within minutes"). Callers must
   * assume this can be wrong and handle 403 as normal — §11.4.
   */
  expiresAt: number;
  /** True for all four candidate backends. */
  supportsRange: boolean;
}

/**
 * §7.1 — the bridge between the app's logical paths and a provider's IDs.
 *
 * `catalog.json` contains logical paths only, because IDs would not survive a backend
 * migration. Graph's content endpoint wants an ID. The provider owns that translation
 * and nothing above it ever sees an ID.
 */
export type StorageRef = { path: string } | { id: string };

export function isPathRef(ref: StorageRef): ref is { path: string } {
  return 'path' in ref;
}

export interface ListResult {
  items: StorageItem[];
  cursor?: string;
  done: boolean;
}

export interface ChangeSet {
  upserted: StorageItem[];
  deletedIds: string[];
  cursor: string;
  /**
   * "Treat as reconciliation, not patch." Set when the provider restarted
   * enumeration from scratch — OneDrive signals this with HTTP 410 Gone (§4.4).
   */
  full: boolean;
}

export interface AppFile {
  data: Uint8Array;
  etag?: string;
}

/**
 * §12.1 step 1–2 requires a conditional catalog read whose 304 costs nothing, so
 * `readAppFile` takes an optional `ifNoneMatch`. This is an additive optional
 * parameter on the §7.2 signature; providers that ignore it still satisfy the
 * interface, they just always re-transfer.
 */
export interface AppFileRead {
  /** True when the server answered 304 — `file` is then absent and nothing changed. */
  notModified: boolean;
  file: AppFile | null;
}

export interface StorageProvider {
  readonly id: 'onedrive' | 'r2' | 'b2' | 's3';

  // ── enumeration (INGEST ONLY — the mobile app never calls these) ────────────
  // Keeping enumeration off the phone is what keeps the §4.4 throttling risk on the
  // desktop, where a `Retry-After: 322` is an inconvenience rather than a dead app.

  list(o: { prefix?: string; cursor?: string; pageSize?: number }): Promise<ListResult>;

  /**
   * OneDrive → native /delta. Object stores → full list + local diff.
   * Persist the returned cursor religiously; a full resync is the single biggest
   * throttling trigger there is.
   */
  changesSince(cursor?: string, opts?: { prefix?: string }): Promise<ChangeSet>;

  // ── playback (THE hot path — cheap, and safely re-callable at any moment) ────

  getStreamUrl(ref: StorageRef, ttlHint?: number): Promise<SignedUrl>;
  openRange(ref: StorageRef, start: number, end?: number): Promise<ReadableStream<Uint8Array>>;
  stat(ref: StorageRef): Promise<StorageItem | null>;

  // ── app documents ───────────────────────────────────────────────────────────

  readAppFile(name: string, opts?: { ifNoneMatch?: string }): Promise<AppFileRead>;
  writeAppFile(name: string, data: Uint8Array, ifMatch?: string): Promise<{ etag: string }>;
  listAppFiles(prefix: string): Promise<{ name: string; modifiedAt: string }[]>;
}

/**
 * Supplies a valid access token. Deliberately *not* implemented here: the app uses
 * `expo-auth-session` + `expo-secure-store`, the CLI uses a loopback redirect and
 * `~/.feast/auth.json` (§9.0). The provider only needs the string.
 */
export interface TokenProvider {
  /** Must return a live token, refreshing silently if needed. */
  getAccessToken(): Promise<string>;
  /** Called when the provider sees a 401 so the next call re-authenticates. */
  invalidate?(): void;
}

/**
 * Persistence for the `path → providerId` map (§7.1 step 1). The app backs this with
 * SQLite/MMKV; the CLI with a JSON file; tests with a Map. Optional — without it the
 * provider still works, it just pays one extra round trip on a cold path.
 */
export interface PathMapStore {
  get(path: string): string | undefined;
  set(path: string, id: string): void;
  delete(path: string): void;
  entries(): Iterable<[string, string]>;
}
