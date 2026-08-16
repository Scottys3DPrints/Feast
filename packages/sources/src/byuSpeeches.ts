/**
 * BYU Speeches adapter — SPEC §4.5.
 *
 * WordPress REST API, open, no auth. Custom post type `speech`.
 *
 * ⚠️ THE AWKWARD PART: **the speech record does not contain the audio URL.** `acf` is
 * empty and there is no enclosure field. Audio has to be resolved from the separate
 * `media` endpoint, then joined back to the speech on speaker surname + date. This is
 * the single reason this adapter is more than twenty lines.
 *
 * ⚠️ There is also **no speaker taxonomy in the REST API**. Speaker lives in the URL
 * path (`/talks/<speaker-slug>/<speech-slug>/`) and in the title, nowhere queryable —
 * which is why "every talk by X" needs a local index rather than a query.
 *
 * MP3 filenames look constructible (`BYUS-Dixon-Sean-R.-2026_03_17-v1.0.mp3`) and are
 * not: punctuation and version suffixes vary. Discover via the media API; never build
 * the URL by hand.
 *
 * §20.1: BYU publishes no terms page and no anti-robot clause, but absence of a
 * prohibition is not a grant, so this is polite-rate-limited too. Their Omny podcast
 * feeds are the publisher's intended subscription route and should be preferred where
 * they cover the need.
 */
import type { PoliteClient } from './http.ts';
import type { BrowseNode, DiscoveredTalk, SourceAdapter } from './types.ts';

const API = 'https://speeches.byu.edu/wp-json/wp/v2';

interface WpSpeech {
  id: number;
  date: string;
  slug: string;
  link: string;
  title?: { rendered?: string };
  content?: { rendered?: string };
  excerpt?: { rendered?: string };
}

interface WpMedia {
  id: number;
  date: string;
  slug: string;
  source_url: string;
  mime_type: string;
  media_details?: {
    length_formatted?: string;
    length?: number;
    bitrate?: number;
    filesize?: number;
  };
}

export interface ByuSpeechesOptions {
  client: PoliteClient;
}

export class ByuSpeechesAdapter implements SourceAdapter {
  readonly id = 'byu-speeches';
  readonly displayName = 'BYU Speeches';
  /** No published grant; treat as polite-only. §20.1. */
  readonly requiresPoliteRateLimit = true;

  private readonly client: PoliteClient;

  constructor(opts: ByuSpeechesOptions) {
    this.client = opts.client;
  }

  /** Pages of the archive, newest first. There is no speaker taxonomy to browse. */
  async browse(node?: string): Promise<BrowseNode[]> {
    if (!node) {
      return [
        { id: 'recent', label: 'Recent speeches', kind: 'collection' },
        { id: 'all', label: 'Full archive', kind: 'collection' },
      ];
    }
    return [];
  }

  /**
   * `node` is `recent` (first page) or `all` (paged to exhaustion).
   *
   * Audio is resolved per speech from the media endpoint, joined on surname + date.
   */
  async discover(node: string, opts: { limit?: number } = {}): Promise<DiscoveredTalk[]> {
    const limit = opts.limit ?? (node === 'recent' ? 20 : Number.MAX_SAFE_INTEGER);
    const out: DiscoveredTalk[] = [];

    let page = 1;
    while (out.length < limit) {
      const perPage = Math.min(100, limit - out.length);
      const url = `${API}/speech?per_page=${perPage}&orderby=date&order=desc&page=${page}`;

      let speeches: WpSpeech[] | null;
      try {
        const res = await this.client.getJson<WpSpeech[]>(url);
        speeches = res.data;
      } catch {
        // WordPress answers 400 past the last page rather than an empty array.
        break;
      }
      if (!speeches?.length) break;

      for (const speech of speeches) {
        const talk = await this.toTalk(speech);
        if (talk) out.push(talk);
        if (out.length >= limit) break;
      }

      if (speeches.length < perPage) break;
      page += 1;
    }

    return out;
  }

  private async toTalk(speech: WpSpeech): Promise<DiscoveredTalk | null> {
    const title = stripTags(speech.title?.rendered ?? '').trim();
    const speaker = speakerFromLink(speech.link);
    if (!speaker) return null;

    const media = await this.findAudio(speaker, speech.date);
    if (!media) return null;

    const talk: DiscoveredTalk = {
      externalId: `byu:${speech.id}`,
      title: title || 'Untitled',
      speaker,
      audioUrl: media.source_url,
      sourceUrl: speech.link,
      eventName: 'BYU Speeches',
      publishedAt: speech.date,
      suggestedTags: ['byu-speeches'],
    };

    const seconds = media.media_details?.length;
    if (typeof seconds === 'number') talk.durationSec = seconds;
    const filesize = media.media_details?.filesize;
    if (typeof filesize === 'number') talk.sizeBytes = filesize;

    // Bulk list queries return empty content for the newest items (⚪ likely embargoed
    // transcripts), so this is best-effort rather than guaranteed.
    const transcript = stripTags(speech.content?.rendered ?? '').trim();
    if (transcript) talk.transcript = transcript;

    return talk;
  }

  /**
   * The join: search media by surname, then match on the closest date.
   *
   * Dates are matched within a window rather than exactly, because the media item is
   * often uploaded a day or two either side of the speech's publish date.
   */
  private async findAudio(speaker: string, speechDate: string): Promise<WpMedia | null> {
    const surname = speaker.split(/\s+/).pop() ?? speaker;
    const url =
      `${API}/media?search=${encodeURIComponent(surname)}` +
      `&per_page=20&_fields=id,date,slug,source_url,mime_type,media_details`;

    let items: WpMedia[] | null;
    try {
      const res = await this.client.getJson<WpMedia[]>(url);
      items = res.data;
    } catch {
      return null;
    }
    if (!items?.length) return null;

    const audio = items.filter((m) => m.mime_type === 'audio/mpeg');
    if (!audio.length) return null;

    const target = Date.parse(speechDate);
    let best: WpMedia | null = null;
    let bestGap = Number.POSITIVE_INFINITY;

    for (const item of audio) {
      const gap = Math.abs(Date.parse(item.date) - target);
      if (gap < bestGap) {
        bestGap = gap;
        best = item;
      }
    }

    // Beyond ~30 days apart it is almost certainly a different speech by the same
    // speaker; a wrong audio file is worse than none, because it looks correct.
    return bestGap <= 30 * 24 * 60 * 60 * 1000 ? best : null;
  }
}

/** Speaker lives in the URL path: /talks/<speaker-slug>/<speech-slug>/ */
export function speakerFromLink(link: string): string | null {
  const m = /\/talks\/([^/]+)\//.exec(link);
  if (!m?.[1]) return null;
  return m[1]
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
