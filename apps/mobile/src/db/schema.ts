import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Drizzle table definitions mirroring `migrations.ts` — SPEC §6.2.
 *
 * ⚠️ `migrations.ts` is the source of truth for the DDL (it has to be: §4.6 notes
 * Drizzle cannot model the FTS5 virtual table, and the explicit `rowid` and the three
 * triggers are not expressible here either). These definitions exist to give the app
 * typed, composable queries over the same tables. If you change one, change both.
 *
 * Dates are epoch-ms INTEGERs throughout, per §6.0.
 */

export const speakers = sqliteTable('speakers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  sortName: text('sort_name').notNull(),
  role: text('role').notNull(),
  successionOrder: integer('succession_order'),
  /** JSON array. */
  aliases: text('aliases').notNull().default('[]'),
  photoPath: text('photo_path'),
  gradientSeed: text('gradient_seed').notNull(),
  bio: text('bio'),
});

export const series = sqliteTable('series', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('other'),
  speakerId: text('speaker_id'),
  description: text('description'),
  artworkPath: text('artwork_path'),
  totalParts: integer('total_parts'),
});

export const talks = sqliteTable('talks', {
  /** Explicit and stable — the FTS5 external-content table maps on it (§6.2). */
  rowid: integer('rowid').primaryKey(),
  id: text('id').notNull().unique(),
  contentHash: text('content_hash').notNull(),
  title: text('title').notNull(),
  subtitle: text('subtitle'),
  speakerId: text('speaker_id'),
  /** Denormalized for FTS5. Refresh on speaker rename. */
  speakerName: text('speaker_name').notNull().default(''),
  seriesId: text('series_id'),
  partNumber: integer('part_number'),
  durationSec: integer('duration_sec'),
  publishedAt: integer('published_at'),
  recordedYear: integer('recorded_year'),
  eventName: text('event_name'),
  sessionName: text('session_name'),
  archivePath: text('archive_path').notNull(),
  streamPath: text('stream_path'),
  sizeBytes: integer('size_bytes').notNull(),
  streamSizeBytes: integer('stream_size_bytes'),
  mimeType: text('mime_type').notNull(),
  artworkPath: text('artwork_path'),
  artworkColor: text('artwork_color'),
  transcript: text('transcript'),
  transcriptSource: text('transcript_source'),
  sourceUrl: text('source_url'),
  source: text('source').notNull(),
  importedAt: integer('imported_at').notNull(),
  /** JSON array — every path this content was found at (§9.3). */
  originalPaths: text('original_paths').notNull().default('[]'),
  parseConfidence: real('parse_confidence').notNull().default(1),
  /** JSON array of TalkFlag. */
  flags: text('flags').notNull().default('[]'),
  /** §12.1 — soft hide. Talks are NEVER hard-deleted by a catalog sync. */
  missingSince: integer('missing_since'),
});

export const collections = sqliteTable('collections', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  kind: text('kind').notNull().default('user'),
  /** 'catalog' | 'device' — governs deletion authority (§12.1). */
  origin: text('origin').notNull().default('device'),
  icon: text('icon'),
  color: text('color'),
  sortOrder: integer('sort_order').notNull().default(0),
  parentId: text('parent_id'),
  smartQuery: text('smart_query'),
  pinned: integer('pinned').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
  deviceId: text('device_id').notNull(),
});

export const collectionMembers = sqliteTable('collection_members', {
  collectionId: text('collection_id').notNull(),
  talkId: text('talk_id').notNull(),
  /** Fractional index, deviceId-suffixed. Sort by (orderKey, talkId) — §12.4. */
  orderKey: text('order_key').notNull(),
  origin: text('origin').notNull().default('device'),
  addedAt: integer('added_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
  deviceId: text('device_id').notNull(),
});

export const tags = sqliteTable('tags', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  color: text('color'),
  kind: text('kind').notNull().default('user'),
  origin: text('origin').notNull().default('device'),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
  deviceId: text('device_id').notNull(),
});

export const talkTags = sqliteTable('talk_tags', {
  talkId: text('talk_id').notNull(),
  tagId: text('tag_id').notNull(),
  origin: text('origin').notNull().default('device'),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
  deviceId: text('device_id').notNull(),
});

export const listenState = sqliteTable('listen_state', {
  talkId: text('talk_id').primaryKey(),
  positionSec: real('position_sec').notNull().default(0),
  played: integer('played').notNull().default(0),
  playCount: integer('play_count').notNull().default(0),
  completedAt: integer('completed_at'),
  rating: integer('rating'),
  favorite: integer('favorite').notNull().default(0),
  note: text('note'),
  updatedAt: integer('updated_at').notNull(),
  deviceId: text('device_id').notNull(),
});

export const bookmarks = sqliteTable('bookmarks', {
  id: text('id').primaryKey(),
  talkId: text('talk_id').notNull(),
  positionSec: real('position_sec').notNull(),
  label: text('label'),
  note: text('note'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
  deviceId: text('device_id').notNull(),
});

export const cacheEntries = sqliteTable('cache_entries', {
  talkId: text('talk_id').notNull(),
  rendition: text('rendition').notNull(),
  localPath: text('local_path').notNull(),
  bytes: integer('bytes').notNull().default(0),
  /** Expected size — the Android partial-file guard (§4.7, §11.3). */
  contentLength: integer('content_length').notNull().default(0),
  state: text('state').notNull().default('pending'),
  pinned: integer('pinned').notNull().default(0),
  /** 0 = never played. COALESCE with downloadedAt when sorting for eviction. */
  lastPlayedAt: integer('last_played_at').notNull().default(0),
  downloadedAt: integer('downloaded_at').notNull().default(0),
  attempts: integer('attempts').notNull().default(0),
});

export const queue = sqliteTable('queue', {
  talkId: text('talk_id').primaryKey(),
  orderKey: text('order_key').notNull(),
  addedAt: integer('added_at').notNull(),
});

export const outbox = sqliteTable('outbox', {
  id: text('id').primaryKey(),
  entity: text('entity').notNull(),
  entityId: text('entity_id').notNull(),
  op: text('op').notNull(),
  /** The CHANGED FIELDS ONLY, for correct 412 merges (§12.2). */
  payload: text('payload').notNull(),
  createdAt: integer('created_at').notNull(),
  attempts: integer('attempts').notNull().default(0),
});

export const syncMeta = sqliteTable('sync_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export type TalkRow = typeof talks.$inferSelect;
export type SpeakerRow = typeof speakers.$inferSelect;
export type SeriesRow = typeof series.$inferSelect;
export type CollectionRow = typeof collections.$inferSelect;
export type ListenStateRow = typeof listenState.$inferSelect;
export type CacheEntryRow = typeof cacheEntries.$inferSelect;
