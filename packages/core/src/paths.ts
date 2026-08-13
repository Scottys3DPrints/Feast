/**
 * Logical-path utilities and filename parsing — SPEC §7.1, §9.5.
 *
 * "Logical path" means a provider-neutral, forward-slashed, root-relative path such
 * as `Talks/By Speaker/Prophets/17 Russell M. Nelson/x.mp3`. It is the ONLY way
 * anything above `packages/storage` addresses content (§7.2 rule 1) — no driveItem
 * IDs, no object keys, no absolute filesystem paths.
 */

/** Collapse separators, drop `.`/`..` and empty segments, force forward slashes. */
export function normalizePath(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.join('/'));
}

export function pathSegments(path: string): string[] {
  return normalizePath(path).split('/').filter(Boolean);
}

export function basename(path: string): string {
  const segs = pathSegments(path);
  return segs[segs.length - 1] ?? '';
}

export function dirname(path: string): string {
  return pathSegments(path).slice(0, -1).join('/');
}

/** ".mp3" — lowercased, including the dot. Empty string when there is no extension. */
export function extname(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

export function stripExtension(name: string): string {
  const ext = extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

/** Extensions we treat as audio at import time. */
export const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.m4b', '.aac', '.wav', '.wma', '.ogg', '.opus'];

/** §1: the single .wma plays on neither iOS nor Android. `feast doctor` flags these. */
export const UNPLAYABLE_EXTENSIONS = ['.wma', '.ogg', '.opus'];

export function isAudioPath(path: string): boolean {
  return AUDIO_EXTENSIONS.includes(extname(path));
}

export function mimeTypeFor(path: string): string {
  switch (extname(path)) {
    case '.mp3':
      return 'audio/mpeg';
    case '.m4a':
    case '.m4b':
    case '.aac':
      return 'audio/mp4';
    case '.wav':
      return 'audio/wav';
    case '.wma':
      return 'audio/x-ms-wma';
    case '.ogg':
    case '.opus':
      return 'audio/ogg';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Percent-encode a logical path for Graph's path addressing (§7.1 step 2):
 * `GET /me/drive/root:/{encoded}:/…`. Segment separators stay literal; everything
 * else — including `#`, `?`, `&`, and the apostrophes and smart quotes this archive
 * is full of — is encoded.
 */
export function encodePathForUrl(path: string): string {
  return pathSegments(path).map(encodeURIComponent).join('/');
}

// ─── Filename parsing — §9.5 ────────────────────────────────────────────────────

export interface ParsedFilename {
  title: string;
  /** Present only when the filename genuinely carried a speaker. */
  speaker?: string;
  /** Leading `NN ` or `#N ` — a track/part number. */
  trackNumber?: number;
  year?: number;
  /** "Education Week" and friends, when the filename names an event. */
  eventName?: string;
  /** 0..1. Below 0.7 the talk lands in Needs Attention (§15.14). */
  confidence: number;
}

/** Smart quotes, en-dashes, and the `_`-was-an-apostrophe case (§9.5). */
export function normalizePunctuation(raw: string): string {
  return raw
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    // "Jerusalem_s Formula for Peace" → "Jerusalem's". Only between letters, and only
    // where an apostrophe is plausible — `_s`, `_t`, `_re`, `_ve`, `_ll`, `_d`, `_m`.
    .replace(/([A-Za-z])_(s|t|re|ve|ll|d|m)\b/g, "$1'$2")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Trailing `-1` / `(2)` dedupe suffixes that Windows and OneDrive add. */
export function stripDedupeSuffix(name: string): string {
  return name.replace(/[\s._-]*(?:-\d{1,2}|\(\d{1,2}\))$/u, '').trim();
}

const EVENT_PATTERNS: Array<{ re: RegExp; name: string }> = [
  { re: /\bed(?:ucation)?\s*week\b/i, name: 'Education Week' },
  { re: /\bgeneral\s+conference\b/i, name: 'General Conference' },
  { re: /\bdevotional\b/i, name: 'BYU Devotional' },
  { re: /\bfireside\b/i, name: 'Fireside' },
  { re: /\bwomen'?s\s+conference\b/i, name: "Women's Conference" },
];

/**
 * Parse a bare filename into title / speaker / track / year / event.
 *
 * `knownSpeakers` is the canonical speaker-name list from §9.4. It is what lets the
 * ` - ` split be resolved in the right order — both
 * `"Thou Shalt Be Nice! - Hank Smith"` and
 * `"John G. Bytheway, 2006 Ed Week, Righteous Warriors"` occur in this archive.
 */
export function parseFilename(filename: string, knownSpeakers: readonly string[] = []): ParsedFilename {
  let work = normalizePunctuation(stripDedupeSuffix(stripExtension(basename(filename))));
  let confidence = 1;

  // Leading track/part number: "06 Dead Sea Scrolls…", "#2 Meaning of the Atonement".
  let trackNumber: number | undefined;
  const trackMatch = /^(?:#\s*(\d{1,3})|(\d{1,3}))[\s.\-–]+(.+)$/.exec(work);
  if (trackMatch) {
    const n = Number(trackMatch[1] ?? trackMatch[2]);
    // A 4-digit-looking lead is a year, not a track; the regex already caps at 3.
    if (n > 0 && n < 200) {
      trackNumber = n;
      work = trackMatch[3]!.trim();
    }
  }

  // "Part 03 (17 Points of the True Church)" — the part number wins over the series
  // name here; the series itself comes from the folder (§9.4), which is authoritative.
  const partMatch = /^part\s+(\d{1,3})\s*(?:\((.+)\))?$/i.exec(work);
  if (partMatch) {
    trackNumber = Number(partMatch[1]);
    work = (partMatch[2] ?? work).trim();
  }

  // Year, anywhere: "2006 Ed Week", "Education Week 2003".
  let year: number | undefined;
  const yearMatch = /\b(19[5-9]\d|20[0-4]\d)\b/.exec(work);
  if (yearMatch) year = Number(yearMatch[1]);

  let eventName: string | undefined;
  for (const { re, name } of EVENT_PATTERNS) {
    if (re.test(work)) {
      eventName = name;
      break;
    }
  }

  // Split on ` - ` or `, ` and test every field against the speaker table. Whichever
  // field matches a known speaker IS the speaker, regardless of position — which is
  // what makes both filename conventions in this archive parse correctly.
  const fields = work
    .split(/\s+-\s+|\s*,\s+/)
    .map((f) => f.trim())
    .filter(Boolean);

  let speaker: string | undefined;
  let titleFields = fields;

  if (fields.length > 1 && knownSpeakers.length > 0) {
    const normalizedKnown = new Set(knownSpeakers.map((s) => s.toLowerCase().replace(/[^a-z]/g, '')));
    const idx = fields.findIndex((f) => normalizedKnown.has(f.toLowerCase().replace(/[^a-z]/g, '')));
    if (idx >= 0) {
      speaker = fields[idx];
      titleFields = fields.filter((_, i) => i !== idx);
    }
  }

  if (!speaker && fields.length > 1) {
    // No table hit. Guess only when a field *looks* like a personal name
    // ("Hank Smith", "John G. Bytheway") — and pay for the guess in confidence.
    const nameLike = /^[A-Z][a-z]+(?:\s+[A-Z]\.?)*\s+[A-Z][a-z]+$/;
    const idx = fields.findIndex((f) => nameLike.test(f));
    if (idx >= 0) {
      speaker = fields[idx];
      titleFields = fields.filter((_, i) => i !== idx);
      confidence -= 0.2;
    } else {
      confidence -= 0.1;
    }
  }

  // Drop fields that are pure event/year noise from the title.
  const cleanedTitleFields = titleFields.filter((f) => {
    const bare = f.replace(/\b(19|20)\d{2}\b/g, '').trim();
    if (!bare) return false;
    return !EVENT_PATTERNS.some(({ re }) => re.test(bare) && bare.replace(re, '').trim() === '');
  });

  let title = (cleanedTitleFields.length ? cleanedTitleFields : titleFields).join(' - ').trim();

  if (!title) {
    title = work;
    confidence -= 0.3;
  }

  // ALL CAPS sources get title-cased; mixed case is left exactly as the user had it.
  if (title === title.toUpperCase() && /[A-Z]{4,}/.test(title)) {
    title = titleCase(title);
    confidence -= 0.05;
  }

  if (title.length < 3) confidence -= 0.3;
  if (/^\d+$/.test(title)) confidence -= 0.4;

  const parsed: ParsedFilename = {
    title,
    confidence: Math.max(0, Math.min(1, Number(confidence.toFixed(2)))),
  };
  if (speaker) parsed.speaker = speaker;
  if (trackNumber !== undefined) parsed.trackNumber = trackNumber;
  if (year !== undefined) parsed.year = year;
  if (eventName) parsed.eventName = eventName;
  return parsed;
}

const LOWERCASE_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor', 'of',
  'on', 'or', 'the', 'to', 'upon', 'with',
]);

export function titleCase(raw: string): string {
  const words = raw.toLowerCase().split(/\s+/);
  return words
    .map((w, i) => {
      if (i > 0 && i < words.length - 1 && LOWERCASE_WORDS.has(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

/** Human byte counts for every "we are about to use disk" moment (§3 principle 3). */
export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = value >= 100 ? 0 : fractionDigits;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** `754` → `12:34`; `7754` → `2:09:14`. Used for durations and scrubber times. */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds) || totalSeconds < 0) return '--:--';
  const s = Math.floor(totalSeconds % 60);
  const m = Math.floor((totalSeconds / 60) % 60);
  const h = Math.floor(totalSeconds / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
