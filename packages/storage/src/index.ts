/**
 * @feast/storage — the migration insurance policy (SPEC §7).
 *
 * ⚠️ THE MOST IMPORTANT RULE IN THE REPO (§7.2 rule 1, acceptance criterion 18):
 * nothing outside this package may import a Microsoft Graph type, hold a driveItem
 * id, or build a Graph URL. Everything above this boundary addresses content by
 * logical path, with `contentHash` as identity.
 *
 * Honour that and migrating to B2/R2/S3 is one new file (~300–500 LOC) plus a
 * re-index. Every collection, rating, and bookmark survives untouched.
 */

export * from './types';
export * from './errors';
export { OneDriveProvider, APP_FOLDER_PREFIX } from './onedrive/OneDriveProvider';
export type { OneDriveProviderOptions } from './onedrive/OneDriveProvider';
export { MemoryPathMap, FolderTree } from './onedrive/pathMap';
export type { FolderNode } from './onedrive/pathMap';
export type { ThrottleListener } from './onedrive/graphClient';

/** Canonical app-document names (§6.3). One writer per file, always. */
export const APP_FILES = {
  /** ingest writes · app reads */
  catalog: 'catalog.json',
  /** app writes · ingest reads */
  state: 'state.json',
  /** app writes · ingest reads — immutable once written */
  jobsDir: 'jobs',
  /** ingest writes · app reads */
  resultsDir: 'results',
  transcriptShard: (n: number) => `transcripts-${String(n).padStart(3, '0')}.ndjson`,
} as const;
