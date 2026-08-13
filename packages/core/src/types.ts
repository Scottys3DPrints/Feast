/**
 * Core domain entities — SPEC §6.1.
 *
 * These types are the contract between `feast-ingest`, `catalog.json`, and the app's
 * SQLite schema. Two conventions from §6.0 govern them and are easy to get wrong:
 *
 *   1. DATES. Every `…At` field typed `string` here is ISO-8601, because these types
 *      describe the *JSON* representation. SQLite stores epoch-ms. Conversion goes
 *      through `codec.ts`, nowhere else. The exception is `updatedAt`, typed `number`
 *      (epoch ms) everywhere, because it is a logical clock rather than a date.
 *
 *   2. HASHES. `contentHash` is ours (SHA-256 over first 1 MB ‖ last 1 MB ‖ size) and
 *      is the dedup key. `providerHash` is the backend's and never leaves
 *      `packages/storage`. They are never compared.
 */

// ─── Talks ──────────────────────────────────────────────────────────────────────

export type TalkFlag =
  /** from My List/_Redownload */
  | 'needs-redownload'
  /** speaker unknown or ambiguous */
  | 'needs-attribution'
  /** bitrate below threshold */
  | 'low-quality'
  /** duration far below series peers */
  | 'incomplete'
  /** same content reached us from two sources */
  | 'duplicate-source'
  /** cache download failed or verified corrupt */
  | 'download-failed'
  /** e.g. the one .wma */
  | 'unplayable-format';

export type TalkSource = 'import' | 'general-conference' | 'byu-speeches' | 'rss' | 'manual';

export type TranscriptSource = 'church-api' | 'byu-api' | 'user' | 'whisper';

/** A talk is an ENTITY, not a file. This is the fix for P2/P3. */
export interface Talk {
  /** UUIDv7, generated at import, STABLE FOREVER. */
  id: string;
  /** §6.0 — the dedup key, provider-independent. */
  contentHash: string;

  title: string;
  subtitle?: string;
  speakerId: string;
  /**
   * DENORMALIZED — required by the FTS5 external-content table (§6.2), which issues
   * `SELECT title, transcript, speaker_name FROM talks WHERE rowid = ?`.
   * Refresh on speaker rename.
   */
  speakerName: string;
  seriesId?: string;
  /** "Part 03 (17 Points of the True Church)" → 3 */
  partNumber?: number;

  durationSec?: number;
  /** ISO 8601, if known. */
  publishedAt?: string;
  recordedYear?: number;
  /** "October 2024 General Conference", "BYU Devotional" */
  eventName?: string;
  /** "Saturday Morning Session" */
  sessionName?: string;

  // ── storage (provider-relative LOGICAL paths, NEVER provider IDs — §7.1) ──
  /** e.g. "Talks/By Speaker/Prophets/17 Russell M. Nelson/x.mp3" */
  archivePath: string;
  /** "Talks/_stream/<id>.m4a" — the HE-AAC v2 transcode (§2). Phase 5. */
  streamPath?: string;
  sizeBytes: number;
  streamSizeBytes?: number;
  mimeType: string;

  // ── presentation ──
  /** "Talks/_artwork/<id>.jpg" — extracted at import (§9.2). */
  artworkPath?: string;
  /** "#3A4A6B" dominant color; drives the gradient fallback. */
  artworkColor?: string;

  // ── text ──
  /** Plain text. NOT carried in catalog.json — it ships in transcript shards (§6.3). */
  transcript?: string;
  transcriptSource?: TranscriptSource;
  /** Canonical web page. */
  sourceUrl?: string;

  // ── provenance ──
  source: TalkSource;
  importedAt: string;
  /** EVERY path this content was found at — the dedup record (§9.3). */
  originalPaths: string[];
  /** 0..1 from §9.5. < 0.7 ⇒ Needs Attention (§15.14). */
  parseConfidence: number;

  // ── health ──
  flags: TalkFlag[];
}

// ─── Speakers & series ──────────────────────────────────────────────────────────

export type SpeakerRole = 'prophet' | 'apostle' | 'seventy' | 'auxiliary' | 'scholar' | 'other';

export interface Speaker {
  /** slug: "russell-m-nelson" */
  id: string;
  name: string;
  /** "Nelson, Russell M." */
  sortName: string;
  role: SpeakerRole;
  /** 17 for Nelson — parsed from the "17 " folder prefix. */
  successionOrder?: number;
  aliases: string[];
  photoPath?: string;
  /** Deterministic fallback artwork when photoPath is absent. */
  gradientSeed: string;
  bio?: string;
}

export type SeriesKind = 'lecture' | 'podcast' | 'audiobook' | 'conference' | 'other';

/**
 * A multi-part set: a lecture series, a podcast show, an audiobook.
 * Distinct from Collection: a Series is intrinsic to the content and ORDERED BY
 * partNumber; a Collection is the user's curation.
 */
export interface Series {
  /** slug: "dead-sea-scrolls" */
  id: string;
  name: string;
  kind: SeriesKind;
  /** When a series has one presenter. */
  speakerId?: string;
  description?: string;
  artworkPath?: string;
  /** Declared count, when known; else derived. */
  totalParts?: number;
}

// ─── Curation ───────────────────────────────────────────────────────────────────

export type CollectionKind = 'user' | 'smart' | 'system';

/**
 * `origin` governs deletion authority (§12.1): catalog sync may ONLY delete
 * origin:'catalog' rows. Everything the user made on the phone survives every sync.
 */
export type Origin = 'catalog' | 'device';

/** Ordered, user-curated, NESTABLE. The successor to "My List/_Greatest of All". */
export interface Collection {
  id: string;
  name: string;
  description?: string;
  kind: CollectionKind;
  origin: Origin;
  icon?: string;
  color?: string;
  sortOrder: number;
  /** Collections nest — mirrors the folder tree. */
  parentId?: string;
  /** kind === 'smart' only. */
  smartQuery?: SmartQuery;
  /** Tier 3: keep every member offline. */
  pinned: boolean;
  /** epoch ms */
  updatedAt: number;
  /** SOFT DELETE. Never hard-delete a syncable row. */
  deletedAt?: number;
  deviceId: string;
}

export interface CollectionMember {
  collectionId: string;
  talkId: string;
  /**
   * Fractional index (e.g. "a0", "a0V"). ⚠️ Two devices CAN generate the same key
   * between the same neighbours — a known limitation of the technique. Therefore
   * every key is deviceId-suffixed ("a0:dev1") and sorting is by (orderKey, talkId).
   */
  orderKey: string;
  origin: Origin;
  addedAt: string;
  updatedAt: number;
  deletedAt?: number;
  deviceId: string;
}

/** Free-form, many-to-many. Topics, feelings, whatever. */
export interface Tag {
  id: string;
  name: string;
  color?: string;
  kind: 'topic' | 'scripture' | 'user';
  origin: Origin;
  updatedAt: number;
  deletedAt?: number;
  deviceId: string;
}

export interface TalkTag {
  talkId: string;
  tagId: string;
  origin: Origin;
  updatedAt: number;
  deletedAt?: number;
  deviceId: string;
}

// ─── Saved search / smart collections (§13) ─────────────────────────────────────

export type SmartSortBy =
  | 'title'
  | 'speaker'
  | 'duration'
  | 'addedAt'
  | 'lastPlayedAt'
  | 'rating'
  | 'random';

export type SmartFilter =
  | { field: 'speakerId' | 'seriesId' | 'collectionId' | 'tagId'; op: 'in'; values: string[] }
  | { field: 'role'; op: 'in'; values: SpeakerRole[] }
  | { field: 'rating' | 'durationSec' | 'recordedYear'; op: 'gte' | 'lte' | 'eq'; value: number }
  | { field: 'played' | 'favorite' | 'downloaded' | 'pinned'; op: 'is'; value: boolean }
  | { field: 'flags'; op: 'has'; value: TalkFlag };

/** The saved-search DSL. A saved search IS a smart collection. */
export interface SmartQuery {
  /** FTS5 query string. */
  match?: string;
  /** ANDed together. */
  filters: SmartFilter[];
  sort: { by: SmartSortBy; dir: 'asc' | 'desc' };
  limit?: number;
}

// ─── User state ─────────────────────────────────────────────────────────────────

/** Per-talk user state. Syncs bidirectionally, with the §12.4 merge rules. */
export interface ListenState {
  talkId: string;
  positionSec: number;
  played: boolean;
  playCount: number;
  completedAt?: string;
  /** "_Greatest of All" → 5, "_Second Greatest" → 4 (§9.4). */
  rating?: 1 | 2 | 3 | 4 | 5;
  favorite: boolean;
  note?: string;
  /** epoch ms — the LWW clock. */
  updatedAt: number;
  deviceId: string;
}

/** Timestamped bookmarks within a talk. High-value, low-cost. */
export interface Bookmark {
  id: string;
  talkId: string;
  positionSec: number;
  label?: string;
  note?: string;
  createdAt: string;
  updatedAt: number;
  deletedAt?: number;
  deviceId: string;
}

// ─── Local-only ─────────────────────────────────────────────────────────────────

export type Rendition = 'archive' | 'stream';

export type CacheState = 'pending' | 'downloading' | 'complete' | 'failed';

/** Local-only. NOT synced, NOT in state.json. Rebuildable from disk at any time. */
export interface CacheEntry {
  talkId: string;
  rendition: Rendition;
  /** <docs>/feast/audio/<talkId>.<rendition>.<ext> — §11.3 */
  localPath: string;
  bytes: number;
  /** Expected size — the Android partial-file guard (§4.7). */
  contentLength: number;
  state: CacheState;
  /** true ⇒ never LRU-evicted, never counts against the budget. */
  pinned: boolean;
  /** 0 = never played. */
  lastPlayedAt: number;
  downloadedAt: number;
}

/** PDFs and books. Phase 6 — modeled now so the catalog schema is stable. */
export interface Document {
  id: string;
  title: string;
  speakerId?: string;
  seriesId?: string;
  archivePath: string;
  sizeBytes: number;
  pageCount?: number;
  kind: 'talk-pdf' | 'book-pdf';
  importedAt: string;
}

// ─── Jobs (app → desktop remote control, §6.3) ──────────────────────────────────

export type JobKind =
  | 'fetch-gc-session'
  | 'fetch-gc-speaker'
  | 'fetch-byu-speaker'
  | 'fetch-byu-recent'
  | 'fetch-rss'
  | 'fetch-url'
  | 'redownload'
  | 'transcode'
  | 'transcribe'
  | 'reindex';

export interface Job {
  id: string;
  version: number;
  createdAt: string;
  deviceId: string;
  kind: JobKind;
  params: Record<string, unknown>;
}

export interface JobResult {
  id: string;
  status: 'done' | 'failed' | 'partial';
  startedAt: string;
  completedAt: string;
  result: {
    added: number;
    skipped: number;
    failed: number;
    bytes: number;
  };
  log: string[];
  error: string | null;
}
