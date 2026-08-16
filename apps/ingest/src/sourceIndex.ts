/**
 * The local source index — SPEC §9.6a.
 *
 * ⚠️ WHY THIS FILE EXISTS AT ALL. Neither publisher can answer "every talk by X":
 *
 *  • General Conference has no speaker query, and audio URLs are opaque hashes that
 *    can only be read one talk at a time. Answering "everything Holland ever gave"
 *    live would mean crawling ~110 conference indexes on every request.
 *  • BYU Speeches has no speaker taxonomy in its REST API at all — speaker lives in
 *    the URL path and the title, nowhere queryable.
 *
 * So the crawl happens ONCE, into this file, and every speaker-centric question becomes
 * a local filter. `--refresh` then fetches only what is newer than `lastSeen`, which is
 * normally one or two requests.
 *
 * This is also what keeps the polite-fetch promise affordable: at 1 request/second a
 * full build is a slow background job run rarely, not something a user triggers.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import type { DiscoveredTalk } from '@feast/sources';

export const INDEX_PATH = join(homedir(), '.feast', 'source-index.json');

export interface SourceIndex {
  version: 1;
  gc: {
    builtAt: string | null;
    /** Newest conference seen, `YYYY/MM`. --refresh starts after this. */
    lastConference: string | null;
    talks: DiscoveredTalk[];
  };
  byu: {
    builtAt: string | null;
    /** Highest WordPress speech id seen. */
    lastId: number | null;
    talks: DiscoveredTalk[];
  };
  lastPushedAt: string | null;
}

export function emptyIndex(): SourceIndex {
  return {
    version: 1,
    gc: { builtAt: null, lastConference: null, talks: [] },
    byu: { builtAt: null, lastId: null, talks: [] },
    lastPushedAt: null,
  };
}

export async function loadIndex(): Promise<SourceIndex> {
  try {
    const raw = await readFile(INDEX_PATH, 'utf8');
    const parsed = JSON.parse(raw) as SourceIndex;
    if (parsed?.version !== 1) return emptyIndex();
    return parsed;
  } catch {
    return emptyIndex();
  }
}

export async function saveIndex(index: SourceIndex): Promise<void> {
  await mkdir(dirname(INDEX_PATH), { recursive: true });
  await writeFile(INDEX_PATH, JSON.stringify(index, null, 2), 'utf8');
}

/**
 * Merge freshly discovered talks into a bucket, de-duplicating on `externalId`.
 *
 * New data wins on conflict: a re-index picks up corrected titles and, more
 * importantly, rotated audio URLs. Losing a URL rotation would leave the catalog
 * pointing at a 404 that looks to users like a broken talk.
 */
export function mergeTalks(existing: DiscoveredTalk[], fresh: DiscoveredTalk[]): DiscoveredTalk[] {
  const byId = new Map(existing.map((t) => [t.externalId, t]));
  for (const talk of fresh) byId.set(talk.externalId, talk);
  return [...byId.values()];
}

export function allTalks(index: SourceIndex): DiscoveredTalk[] {
  return [...index.gc.talks, ...index.byu.talks];
}
