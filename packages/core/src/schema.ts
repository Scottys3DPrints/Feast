/**
 * Wire schemas for the OneDrive documents — SPEC §6.3.
 *
 * These are the *only* validated boundary between the desktop tool and the app.
 * Both sides parse with these; neither trusts the other's output shape.
 *
 * Layout under /Apps/Feast/ — SINGLE WRITER PER FILE, which is what makes a
 * serverless design safe:
 *
 *   catalog.json            ingest writes · app reads
 *   transcripts-NNN.ndjson  ingest writes · app reads
 *   state.json              app writes   · ingest reads
 *   jobs/<jobId>.json       app writes   · ingest reads   (immutable once written)
 *   results/<jobId>.json    ingest writes · app reads
 */
import { z } from 'zod';

// ─── Versioning (§12.1 version gate) ────────────────────────────────────────────

/** The catalog schema version this build writes. */
export const CATALOG_VERSION = 1;
/** Oldest catalog the app can read. Below this: "your desktop Feast is out of date". */
export const CATALOG_MIN_VERSION = 1;
/** Newest catalog the app can read. Above this: "update Feast to read this library". */
export const CATALOG_MAX_VERSION = 1;

export const STATE_VERSION = 1;

// ─── Primitives ─────────────────────────────────────────────────────────────────

const isoDate = z.string().min(4);
const epochMs = z.number().int().nonnegative();

export const talkFlagSchema = z.enum([
  'needs-redownload',
  'needs-attribution',
  'low-quality',
  'incomplete',
  'duplicate-source',
  'download-failed',
  'unplayable-format',
]);

export const speakerRoleSchema = z.enum([
  'prophet',
  'apostle',
  'seventy',
  'auxiliary',
  'scholar',
  'other',
]);

export const originSchema = z.enum(['catalog', 'device']);

// ─── Entities ───────────────────────────────────────────────────────────────────

export const speakerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  sortName: z.string().min(1),
  role: speakerRoleSchema,
  successionOrder: z.number().int().positive().optional(),
  aliases: z.array(z.string()).default([]),
  photoPath: z.string().optional(),
  gradientSeed: z.string(),
  bio: z.string().optional(),
});

export const seriesSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['lecture', 'podcast', 'audiobook', 'conference', 'other']).default('other'),
  speakerId: z.string().optional(),
  description: z.string().optional(),
  artworkPath: z.string().optional(),
  totalParts: z.number().int().positive().optional(),
});

export const talkSchema = z.object({
  id: z.string().min(1),
  contentHash: z.string().min(1),

  title: z.string().min(1),
  subtitle: z.string().optional(),
  speakerId: z.string().min(1),
  speakerName: z.string().default(''),
  seriesId: z.string().optional(),
  partNumber: z.number().int().optional(),

  durationSec: z.number().nonnegative().optional(),
  publishedAt: isoDate.optional(),
  recordedYear: z.number().int().optional(),
  eventName: z.string().optional(),
  sessionName: z.string().optional(),

  archivePath: z.string().min(1),
  streamPath: z.string().optional(),
  sizeBytes: z.number().nonnegative(),
  streamSizeBytes: z.number().nonnegative().optional(),
  mimeType: z.string().min(1),

  artworkPath: z.string().optional(),
  artworkColor: z.string().optional(),

  // `transcript` is deliberately absent — transcripts ship in NDJSON shards, because
  // N per-talk files is exactly the request pattern that triggers 429s (§4.4 / §6.3).
  transcriptSource: z.enum(['church-api', 'byu-api', 'user', 'whisper']).optional(),
  sourceUrl: z.string().optional(),

  source: z.enum(['import', 'general-conference', 'byu-speeches', 'rss', 'manual']),
  importedAt: isoDate,
  originalPaths: z.array(z.string()).default([]),
  parseConfidence: z.number().min(0).max(1).default(1),

  flags: z.array(talkFlagSchema).default([]),
});

export const smartQuerySchema: z.ZodType<unknown> = z.object({
  match: z.string().optional(),
  filters: z.array(z.record(z.unknown())).default([]),
  sort: z
    .object({
      by: z.enum(['title', 'speaker', 'duration', 'addedAt', 'lastPlayedAt', 'rating', 'random']),
      dir: z.enum(['asc', 'desc']),
    })
    .default({ by: 'title', dir: 'asc' }),
  limit: z.number().int().positive().optional(),
});

export const collectionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  kind: z.enum(['user', 'smart', 'system']).default('user'),
  origin: originSchema,
  icon: z.string().optional(),
  color: z.string().optional(),
  sortOrder: z.number().int().default(0),
  parentId: z.string().optional(),
  smartQuery: smartQuerySchema.optional(),
  pinned: z.boolean().default(false),
  updatedAt: epochMs,
  deletedAt: epochMs.optional(),
  deviceId: z.string(),
});

export const collectionMemberSchema = z.object({
  collectionId: z.string().min(1),
  talkId: z.string().min(1),
  orderKey: z.string().min(1),
  origin: originSchema,
  addedAt: isoDate,
  updatedAt: epochMs,
  deletedAt: epochMs.optional(),
  deviceId: z.string(),
});

export const tagSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  color: z.string().optional(),
  kind: z.enum(['topic', 'scripture', 'user']).default('user'),
  origin: originSchema,
  updatedAt: epochMs,
  deletedAt: epochMs.optional(),
  deviceId: z.string(),
});

export const talkTagSchema = z.object({
  talkId: z.string().min(1),
  tagId: z.string().min(1),
  origin: originSchema,
  updatedAt: epochMs,
  deletedAt: epochMs.optional(),
  deviceId: z.string(),
});

export const listenStateSchema = z.object({
  talkId: z.string().min(1),
  positionSec: z.number().nonnegative().default(0),
  played: z.boolean().default(false),
  playCount: z.number().int().nonnegative().default(0),
  completedAt: isoDate.optional(),
  rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
  favorite: z.boolean().default(false),
  note: z.string().optional(),
  updatedAt: epochMs,
  deviceId: z.string(),
});

export const bookmarkSchema = z.object({
  id: z.string().min(1),
  talkId: z.string().min(1),
  positionSec: z.number().nonnegative(),
  label: z.string().optional(),
  note: z.string().optional(),
  createdAt: isoDate,
  updatedAt: epochMs,
  deletedAt: epochMs.optional(),
  deviceId: z.string(),
});

export const documentSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  speakerId: z.string().optional(),
  seriesId: z.string().optional(),
  archivePath: z.string().min(1),
  sizeBytes: z.number().nonnegative(),
  pageCount: z.number().int().positive().optional(),
  kind: z.enum(['talk-pdf', 'book-pdf']),
  importedAt: isoDate,
});

// ─── catalog.json ───────────────────────────────────────────────────────────────

/**
 * The ONLY channel by which ingest can seed user state. §12.1 applies it ONCE, on
 * first insert of a talk id, and NEVER thereafter — otherwise every catalog sync
 * would reset the user's listening progress.
 */
export const seedStateSchema = z.object({
  listenState: z
    .array(
      z.object({
        talkId: z.string(),
        played: z.boolean().optional(),
        rating: z.number().int().min(1).max(5).optional(),
        favorite: z.boolean().optional(),
        positionSec: z.number().nonnegative().optional(),
      }),
    )
    .default([]),
  queue: z.array(z.string()).default([]),
});

export const catalogSchema = z.object({
  version: z.number().int().positive(),
  generatedAt: isoDate,
  generatedBy: z.string(),
  /** Provider-relative library root, e.g. "Talks". */
  root: z.string().min(1),
  counts: z.object({
    talks: z.number().int().nonnegative(),
    speakers: z.number().int().nonnegative(),
    series: z.number().int().nonnegative(),
    collections: z.number().int().nonnegative(),
  }),
  transcriptShards: z.array(z.string()).default([]),
  /** §12.1 shrink guard — must be true to accept a >5% drop in talk count. */
  allowShrink: z.boolean().default(false),

  speakers: z.array(speakerSchema).default([]),
  series: z.array(seriesSchema).default([]),
  talks: z.array(talkSchema).default([]),
  collections: z.array(collectionSchema).default([]),
  collectionMembers: z.array(collectionMemberSchema).default([]),
  tags: z.array(tagSchema).default([]),
  talkTags: z.array(z.tuple([z.string(), z.string()])).default([]),
  documents: z.array(documentSchema).default([]),

  seedState: seedStateSchema.default({ listenState: [], queue: [] }),
});

export type CatalogDocument = z.infer<typeof catalogSchema>;

/** One line of a `transcripts-NNN.ndjson` shard. */
export const transcriptLineSchema = z.object({
  talkId: z.string().min(1),
  text: z.string(),
});

// ─── state.json ─────────────────────────────────────────────────────────────────

/**
 * App-written only. ETag-guarded PUT, write-behind ≥30 s.
 * Soft-deleted rows (`deletedAt` set) are INCLUDED — a tombstone is the only way to
 * express a removal across devices (§12.4).
 */
export const stateSchema = z.object({
  version: z.number().int().positive(),
  deviceId: z.string(),
  updatedAt: epochMs,
  listenState: z.array(listenStateSchema).default([]),
  bookmarks: z.array(bookmarkSchema).default([]),
  /**
   * ALL device-origin curation, INCLUDING memberships added to catalog-origin
   * collections. Without this, adding a talk to "Greatest of All" on the phone is
   * erased by the next catalog sync — killing the core organize workflow.
   */
  collections: z.array(collectionSchema).default([]),
  collectionMembers: z.array(collectionMemberSchema).default([]),
  tags: z.array(tagSchema).default([]),
  talkTags: z.array(talkTagSchema).default([]),
  queue: z.array(z.object({ talkId: z.string(), orderKey: z.string() })).default([]),
});

export type StateDocument = z.infer<typeof stateSchema>;

export function emptyState(deviceId: string, now: number): StateDocument {
  return {
    version: STATE_VERSION,
    deviceId,
    updatedAt: now,
    listenState: [],
    bookmarks: [],
    collections: [],
    collectionMembers: [],
    tags: [],
    talkTags: [],
    queue: [],
  };
}

// ─── jobs/ and results/ ─────────────────────────────────────────────────────────

export const jobKindSchema = z.enum([
  'fetch-gc-session',
  'fetch-gc-speaker',
  'fetch-byu-speaker',
  'fetch-byu-recent',
  'fetch-rss',
  'fetch-url',
  'redownload',
  'transcode',
  'transcribe',
  'reindex',
]);

export const jobSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  createdAt: isoDate,
  deviceId: z.string(),
  kind: jobKindSchema,
  params: z.record(z.unknown()).default({}),
});

export const jobResultSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['done', 'failed', 'partial']),
  startedAt: isoDate,
  completedAt: isoDate,
  result: z.object({
    added: z.number().int().nonnegative().default(0),
    skipped: z.number().int().nonnegative().default(0),
    failed: z.number().int().nonnegative().default(0),
    bytes: z.number().nonnegative().default(0),
  }),
  log: z.array(z.string()).default([]),
  error: z.string().nullable().default(null),
});
