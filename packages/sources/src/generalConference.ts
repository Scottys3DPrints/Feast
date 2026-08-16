/**
 * General Conference adapter — SPEC §4.5.
 *
 * Uses the site's own undocumented-but-stable content API, the same one the website
 * calls. No auth, no scraping of rendered HTML for structure.
 *
 *   GET /study/api/v3/language-pages/type/content?lang=eng&uri=<uri>
 *
 * ⚠️ Note the `uri` parameter OMITS the `/study` prefix. Getting that wrong returns a
 * 404 that looks like the talk does not exist.
 *
 * Two findings shape the whole design:
 *
 *  1. **Audio URLs are opaque and non-derivable.** Current audio lives at
 *     `https://assets.churchofjesuschrist.org/<40-char-hash>-128k-<lang>.mp3`, and the
 *     hash cannot be computed from title, speaker, date or slug. The older
 *     `media2.ldscdn.org/...-64k-eng.mp3` pattern is obsolete. So there is no way to
 *     construct a URL — each must be read once and recorded. That is what the index is.
 *
 *  2. **One request enumerates a whole conference.** Passing the index URI
 *     (`/general-conference/2026/04`) returns the session manifest with per-talk title
 *     and speaker, so a conference costs 1 request + 1 per talk for the audio URL,
 *     rather than a crawl.
 *
 * Duration is NOT a meta field — it is `data-duration="778540"` (ms) inside the body
 * HTML, so it is regexed out rather than requested separately.
 *
 * §20.1 applies in full: `requiresPoliteRateLimit` is true and is not negotiable.
 */
import type { PoliteClient } from './http.ts';
import type { BrowseNode, DiscoveredTalk, SourceAdapter } from './types.ts';

const API = 'https://www.churchofjesuschrist.org/study/api/v3/language-pages/type/content';
const WEB = 'https://www.churchofjesuschrist.org/study';

/** The first conference with archived audio on the site. */
const FIRST_YEAR = 1971;

interface ContentResponse {
  meta?: {
    title?: string;
    audio?: Array<{ mediaUrl?: string; variant?: string }>;
    pageAttributes?: Record<string, string>;
    publication?: string;
  };
  content?: { body?: string; head?: string };
  publication?: { title?: string };
  tableOfContentsUri?: string;
}

interface TocEntry {
  uri?: string;
  title?: string;
  /** The site puts the speaker in the secondary/subtitle slot. */
  secondaryTitle?: string;
  content?: TocEntry[];
  section?: string;
}

export interface GeneralConferenceOptions {
  client: PoliteClient;
  lang?: string;
}

export class GeneralConferenceAdapter implements SourceAdapter {
  readonly id = 'general-conference';
  readonly displayName = 'General Conference';
  /** §20.1 — the Church's terms prohibit automated access. Serial and slow, always. */
  readonly requiresPoliteRateLimit = true;

  private readonly client: PoliteClient;
  private readonly lang: string;

  constructor(opts: GeneralConferenceOptions) {
    this.client = opts.client;
    this.lang = opts.lang ?? 'eng';
  }

  /** Years, then the two conferences within a year. Costs zero requests. */
  async browse(node?: string): Promise<BrowseNode[]> {
    if (!node) {
      const thisYear = new Date().getUTCFullYear();
      const years: BrowseNode[] = [];
      for (let y = thisYear; y >= FIRST_YEAR; y -= 1) {
        years.push({ id: String(y), label: String(y), kind: 'year', childCount: 2 });
      }
      return years;
    }

    const year = Number.parseInt(node, 10);
    if (!Number.isFinite(year)) return [];
    return [
      { id: `${year}/04`, label: `April ${year}`, kind: 'session' },
      { id: `${year}/10`, label: `October ${year}`, kind: 'session' },
    ];
  }

  /**
   * Enumerate one conference. `node` is `YYYY/MM`, e.g. `2023/10`.
   *
   * One request for the index, then one per talk for its audio URL — unavoidable,
   * because of finding (1) above.
   */
  async discover(node: string, opts: { limit?: number } = {}): Promise<DiscoveredTalk[]> {
    const [year, month] = node.split('/');
    if (!year || !month) return [];

    const indexUri = `/general-conference/${year}/${month}`;
    const index = await this.client.getJson<ContentResponse>(this.apiUrl(indexUri));
    if (!index.data) return [];

    const entries = parseConferenceIndex(index.data.content?.body ?? '').slice(
      0,
      opts.limit ?? Number.MAX_SAFE_INTEGER,
    );
    const talkUris = entries;

    const eventName = `${month === '04' ? 'April' : 'October'} ${year} General Conference`;
    const out: DiscoveredTalk[] = [];

    for (const entry of talkUris) {
      const talk = await this.fetchTalk(entry, eventName, year);
      if (talk) out.push(talk);
    }
    return out;
  }

  private async fetchTalk(
    entry: TocEntry,
    eventName: string,
    year: string,
  ): Promise<DiscoveredTalk | null> {
    const uri = entry.uri;
    if (!uri) return null;

    const res = await this.client.getJson<ContentResponse>(this.apiUrl(uri));
    const data = res.data;
    if (!data) return null;

    // The whole point of the request: the audio URL, which cannot be constructed.
    const audioUrl = data.meta?.audio?.find((a) => a.mediaUrl)?.mediaUrl;
    if (!audioUrl) return null;

    const body = data.content?.body ?? '';
    const speaker = cleanSpeaker(entry.secondaryTitle ?? '');

    const talk: DiscoveredTalk = {
      externalId: `gc:${uri}`,
      title: (entry.title ?? data.meta?.title ?? 'Untitled').trim(),
      speaker,
      audioUrl,
      sourceUrl: `${WEB}${uri}?lang=${this.lang}`,
      eventName,
      suggestedTags: ['general-conference', year],
    };

    const durationSec = parseDurationMs(body);
    if (durationSec !== undefined) talk.durationSec = durationSec;

    const session = entry.section ?? undefined;
    if (session) talk.sessionName = session;

    const published = data.meta?.pageAttributes?.['datePublished'];
    if (published) talk.publishedAt = published;

    const transcript = htmlToText(body);
    if (transcript) talk.transcript = transcript;

    return talk;
  }

  private apiUrl(uri: string): string {
    // ⚠️ `uri` omits the /study prefix — see the header note.
    return `${API}?lang=${this.lang}&uri=${encodeURIComponent(uri)}`;
  }
}

// ─── Parsing helpers ──────────────────────────────────────────────────────────────

/**
 * Parse the conference index page into one entry per talk.
 *
 * ⚠️ There is NO `toc` field on this endpoint, despite it being the obvious place to
 * look — the response is `{ meta, content, pids, tableOfContentsUri, uri }`, and the
 * listing lives in `content.body` as HTML. An earlier version of this adapter read
 * `data.toc`, found undefined, and reported "0 talks indexed" for every conference
 * while cheerfully making all its requests.
 *
 * The markup is stable and self-describing:
 *
 *   <li data-content-type="general-conference-talk">
 *     <a href="/study/general-conference/2024/04/11oaks?lang=eng">
 *       <p class="primaryMeta">Dallin H. Oaks</p>   ← speaker
 *       <p class="title">Sustaining of General …</p> ← title
 *       <p class="description">…</p>                 ← summary, not the speaker
 *
 * `data-content-type` is the filter that matters: it separates talks from session
 * landing pages without having to guess from slug shapes.
 */
export function parseConferenceIndex(html: string): TocEntry[] {
  const out: TocEntry[] = [];
  if (!html) return out;

  const itemRe =
    /<li data-content-type="general-conference-talk">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

  for (const match of html.matchAll(itemRe)) {
    const href = match[1];
    const inner = match[2];
    if (!href || !inner) continue;

    // Strip the ?lang= query: the URI is the identity, the language is a parameter.
    const uri = href.split('?')[0]?.replace(/^\/study/, '');
    if (!uri) continue;

    const entry: TocEntry = { uri };
    const title = pickClass(inner, 'title');
    if (title) entry.title = title;
    const speaker = pickClass(inner, 'primaryMeta');
    if (speaker) entry.secondaryTitle = speaker;
    out.push(entry);
  }

  return out;
}

function pickClass(html: string, className: string): string | undefined {
  const m = new RegExp(`<p class="${className}">([\\s\\S]*?)</p>`).exec(html);
  if (!m?.[1]) return undefined;
  const text = htmlToText(m[1]);
  return text || undefined;
}

/**
 * Duration is `data-duration="778540"` (milliseconds) in the body HTML — it is not a
 * meta field, so there is nowhere else to read it from without downloading the MP3.
 */
export function parseDurationMs(html: string): number | undefined {
  const m = /data-duration="(\d+)"/.exec(html);
  if (!m?.[1]) return undefined;
  const ms = Number.parseInt(m[1], 10);
  return Number.isFinite(ms) ? Math.round(ms / 1000) : undefined;
}

/** "By Elder Dieter F. Uchtdorf" → "Dieter F. Uchtdorf". */
export function cleanSpeaker(raw: string): string {
  return raw
    .replace(/^by\s+/i, '')
    .replace(/^(elder|president|sister|brother|bishop)\s+/i, '')
    .trim();
}

/**
 * Body HTML → plain text for the transcript index.
 *
 * Deliberately crude: FTS5 wants words, not structure, and a real HTML parser would be
 * a dependency `packages/core`'s "zero runtime deps" discipline exists to avoid.
 */
export function htmlToText(html: string): string {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
