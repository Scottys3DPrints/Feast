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
  async discover(
    node: string,
    opts: { limit?: number; onPage?: (talks: DiscoveredTalk[]) => void | Promise<void> } = {},
  ): Promise<DiscoveredTalk[]> {
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

      const pageTalks: DiscoveredTalk[] = [];
      for (const speech of speeches) {
        const talk = await this.toTalk(speech);
        if (talk) {
          out.push(talk);
          pageTalks.push(talk);
        }
        if (out.length >= limit) break;
      }

      /*
       * ⚠️ Hand each page back as it completes, so the caller can persist.
       *
       * The full archive is ~2,000 speeches and every one costs a second request to
       * resolve its audio, so a complete pass is 40+ minutes of deliberately slow
       * crawling. Returning only at the end means an interruption throws all of it
       * away — and the cost is not just our time, it is asking BYU for the same
       * 4,000 responses over again. General Conference already saves per conference;
       * this is the same guarantee, per page.
       */
      if (pageTalks.length) await opts.onPage?.(pageTalks);

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
   * The join: search media by surname, then match on the date IN THE FILENAME.
   *
   * ⚠️ THE TRAP, AND IT COST 85% OF THE ARCHIVE.
   *
   * A media item's `date` field is when the FILE WAS UPLOADED, not when the talk was
   * given. For a speech from last month those coincide. For the historical archive they
   * are decades apart — `BYUS-Hunter-Milton-R.-1972_03_28.mp3` is a 1972 devotional
   * uploaded in 2025. An earlier version of this method compared upload date against
   * speech date and rejected anything more than 30 days apart, which silently discarded
   * almost every talk older than the digitisation effort: 2,536 speeches in the archive,
   * 385 matched.
   *
   * The real date is in the filename, as `YYYY_MM_DD`. That is what we match on, and it
   * is far stronger than proximity: it is the publisher stating which talk this is.
   *
   * The surname is verified against the filename too, because a search for "Hunter"
   * returns Rebecca K., Milton R. and Howard. Matching the wrong file is worse than
   * matching none — it looks correct and plays the wrong talk.
   */
  private async findAudio(speaker: string, speechDate: string): Promise<WpMedia | null> {
    const surname = speaker.split(/\s+/).pop() ?? speaker;
    const url =
      `${API}/media?search=${encodeURIComponent(surname)}` +
      // 100, not 20: common surnames (Smith, Bednar) have many recordings, and a short
      // page silently hides the right one behind alphabetical neighbours.
      `&per_page=100&_fields=id,date,slug,source_url,mime_type,media_details`;

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

    const speechDay = dayNumber(speechDate);
    const surnameLc = surname.toLowerCase();

    let best: WpMedia | null = null;
    let bestGapDays = Number.POSITIVE_INFINITY;

    for (const item of audio) {
      const filename = (item.source_url ?? '').split('/').pop() ?? '';
      if (!filename.toLowerCase().includes(surnameLc)) continue;

      const fileDay = dateFromFilename(filename);
      if (fileDay === null) continue;

      const gapDays = Math.abs(fileDay - speechDay);
      if (gapDays < bestGapDays) {
        bestGapDays = gapDays;
        best = item;
      }
    }

    // Same day is the norm; ±3 days covers a speech published a little after it was
    // given. Wider than that and it is a different talk by the same person.
    if (best && bestGapDays <= 3) return best;

    // Fallback for files with no date in the name: nearest upload, tightly bounded, and
    // only when the surname matches. Better than dropping the talk, but weak enough
    // that it must stay the exception.
    let fallback: WpMedia | null = null;
    let fallbackGap = Number.POSITIVE_INFINITY;
    const target = Date.parse(speechDate);
    for (const item of audio) {
      const filename = (item.source_url ?? '').split('/').pop() ?? '';
      if (!filename.toLowerCase().includes(surnameLc)) continue;
      if (dateFromFilename(filename) !== null) continue;
      const gap = Math.abs(Date.parse(item.date) - target);
      if (gap < fallbackGap) {
        fallbackGap = gap;
        fallback = item;
      }
    }
    return fallbackGap <= 7 * 24 * 60 * 60 * 1000 ? fallback : null;
  }
}

/**
 * Pull the speech date out of a media filename, as a day number.
 *
 * BYU's convention is `BYUS-<Surname>-<First>-<M.>-<YYYY_MM_DD>-v<ver>.mp3`, with older
 * digitisations as `<Surname>_<First>_<YYYY>_<M>_<D>_...`. Both put the real date of
 * the talk in the name, which is the only trustworthy link between a speech record and
 * its audio — the upload date is not.
 */
export function dateFromFilename(filename: string): number | null {
  const m = /(\d{4})[_-](\d{1,2})[_-](\d{1,2})/.exec(filename);
  if (!m) return null;
  const [, y, mo, d] = m;
  const year = Number.parseInt(y ?? '', 10);
  const month = Number.parseInt(mo ?? '', 10);
  const day = Number.parseInt(d ?? '', 10);
  if (!Number.isFinite(year) || year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

/** Whole days since epoch, so comparisons ignore time-of-day and timezone drift. */
function dayNumber(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : 0;
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
