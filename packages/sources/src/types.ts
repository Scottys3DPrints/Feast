/**
 * `SourceAdapter` — pluggable acquisition — SPEC §8.
 *
 * ⚠️ THE CENTRAL CONSTRAINT: an adapter discovers METADATA AND AUDIO URLS. It never
 * downloads audio, and nothing built on it ever hosts audio.
 *
 * That is what makes a shared catalogue of ~6,000 talks cost ~5 MB instead of ~90 GB:
 * Firestore stores the description and the publisher's own URL, and playback streams
 * from the publisher's CDN. Storing the bytes ourselves would mean paying to
 * redistribute files that are already served, for free, by the people who made them.
 */

export type SpeakerRoleHint = 'prophet' | 'apostle' | 'seventy' | 'auxiliary' | 'scholar' | 'other';

/** One talk as a source describes it, before it becomes a catalog `Talk`. */
export interface DiscoveredTalk {
  /** Stable per source — the dedup key BEFORE anything is fetched. */
  externalId: string;
  title: string;
  speaker: string;
  speakerRole?: SpeakerRoleHint;

  /**
   * The publisher's own audio URL, played directly.
   *
   * ⚠️ For General Conference this is a 40-character opaque hash and is NOT derivable
   * from title, speaker, date or slug (§4.5). There is no constructible URL: it must be
   * read per talk and recorded, which is the entire reason the index exists.
   */
  audioUrl: string;

  durationSec?: number;
  sizeBytes?: number;
  publishedAt?: string;
  eventName?: string;
  sessionName?: string;
  transcript?: string;
  /** The canonical human-readable page, for attribution and "open on the web". */
  sourceUrl: string;
  suggestedTags: string[];
}

/** A browsable node — years, sessions, speakers — for the in-app Discover UI. */
export interface BrowseNode {
  id: string;
  label: string;
  kind: 'year' | 'session' | 'speaker' | 'collection';
  childCount?: number;
}

export interface SourceAdapter {
  readonly id: string;
  readonly displayName: string;
  /** §20.1 — true means concurrency 1 and ≥1 s between requests, without exception. */
  readonly requiresPoliteRateLimit: boolean;

  /** Browsable hierarchy: years → sessions, speakers → speeches. */
  browse(node?: string): Promise<BrowseNode[]>;

  /** Enumerate everything under a node WITHOUT downloading audio. */
  discover(node: string, opts?: { limit?: number }): Promise<DiscoveredTalk[]>;

  /** Optional second pass where transcripts need a per-item request. */
  hydrate?(talk: DiscoveredTalk): Promise<DiscoveredTalk>;
}
