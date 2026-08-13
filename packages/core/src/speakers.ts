/**
 * Speaker canonicalization — SPEC §9.4.
 *
 * "Russell M. Nelson", "Russell M Nelson", "President Nelson", "Pres. Nelson" and
 * "Nelson, Russell M." must all resolve to `russell-m-nelson`.
 *
 * ⚠️ Fuzzy matching NEVER silently merges. `resolveSpeaker` returns a confidence and
 * the caller decides; §9.4 requires a confirmation prompt for anything below `exact`.
 */
import type { Speaker, SpeakerRole } from './types.js';

/** Diacritic-stripped, punctuation-free, lowercase, single-spaced. */
export function normalizeName(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.,'’"“”]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** "Russell M. Nelson" → "russell-m-nelson" */
export function speakerSlug(name: string): string {
  return normalizeName(name).replace(/\s+/g, '-');
}

/** Honorifics that carry no identity and must be stripped before matching. */
const HONORIFICS = [
  'president',
  'pres',
  'elder',
  'sister',
  'brother',
  'bishop',
  'dr',
  'prof',
  'professor',
];

/** Strip a leading honorific. "Pres. Nelson" → "Nelson". */
export function stripHonorific(raw: string): string {
  const words = raw.trim().split(/\s+/);
  const first = words[0];
  if (!first) return raw.trim();
  const head = normalizeName(first);
  if (HONORIFICS.includes(head) && words.length > 1) {
    return words.slice(1).join(' ');
  }
  return raw.trim();
}

/** "Nelson, Russell M." → "Russell M. Nelson". Leaves already-forward names alone. */
export function unflipSortName(raw: string): string {
  const m = /^([^,]+),\s*(.+)$/.exec(raw.trim());
  if (!m) return raw.trim();
  const [, last, rest] = m;
  return `${rest!.trim()} ${last!.trim()}`;
}

/** "Russell M. Nelson" → "Nelson, Russell M." */
export function toSortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name.trim();
  const last = parts[parts.length - 1]!;
  const rest = parts.slice(0, -1).join(' ');
  return `${last}, ${rest}`;
}

/** Surname only, for the loose match tier and for the BYU media-endpoint join (§4.5). */
export function surname(name: string): string {
  const forward = unflipSortName(stripHonorific(name));
  const parts = normalizeName(forward).split(' ').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/**
 * Normalized Levenshtein similarity in [0, 1]. §9.4 uses ≥ 0.85 as the fuzzy
 * threshold — above it we *propose* a merge, we never perform one.
 */
export function similarity(a: string, b: string): number {
  const s = normalizeName(a);
  const t = normalizeName(b);
  if (s === t) return 1;
  if (s.length === 0 || t.length === 0) return 0;

  // Two-row Levenshtein — O(min(n,m)) space.
  let prev = new Array<number>(t.length + 1);
  let curr = new Array<number>(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;

  for (let i = 1; i <= s.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  const distance = prev[t.length]!;
  return 1 - distance / Math.max(s.length, t.length);
}

export type SpeakerMatchConfidence = 'exact' | 'alias' | 'surname' | 'fuzzy' | 'none';

export interface SpeakerMatch {
  speaker: Speaker | null;
  confidence: SpeakerMatchConfidence;
  /** 0..1 — 1 for exact/alias hits, the similarity score for fuzzy ones. */
  score: number;
  /** True when §9.4 requires a confirmation prompt before merging. */
  needsConfirmation: boolean;
}

const NO_MATCH: SpeakerMatch = {
  speaker: null,
  confidence: 'none',
  score: 0,
  needsConfirmation: false,
};

/**
 * Resolve a raw name against a known speaker table.
 *
 * Tiers, in order: exact normalized name → declared alias → unique surname →
 * fuzzy ≥ 0.85. Only the first two are safe to apply automatically.
 */
export function resolveSpeaker(
  raw: string,
  known: readonly Speaker[],
  opts: { fuzzyThreshold?: number } = {},
): SpeakerMatch {
  const threshold = opts.fuzzyThreshold ?? 0.85;
  const cleaned = unflipSortName(stripHonorific(raw));
  const norm = normalizeName(cleaned);
  if (!norm) return NO_MATCH;

  for (const s of known) {
    if (normalizeName(s.name) === norm) {
      return { speaker: s, confidence: 'exact', score: 1, needsConfirmation: false };
    }
  }

  for (const s of known) {
    if (s.aliases.some((a) => normalizeName(a) === norm)) {
      return { speaker: s, confidence: 'alias', score: 1, needsConfirmation: false };
    }
  }

  // Surname only helps when it is unambiguous across the whole table. "Nelson" is
  // safe here; "Smith" (Joseph, Hank, Joseph Fielding, George Albert) is not.
  const sn = surname(cleaned);
  if (sn) {
    const bySurname = known.filter((s) => surname(s.name) === sn);
    if (bySurname.length === 1) {
      return { speaker: bySurname[0]!, confidence: 'surname', score: 0.9, needsConfirmation: true };
    }
  }

  let best: Speaker | null = null;
  let bestScore = 0;
  for (const s of known) {
    const score = Math.max(similarity(cleaned, s.name), ...s.aliases.map((a) => similarity(cleaned, a)));
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  if (best && bestScore >= threshold) {
    return { speaker: best, confidence: 'fuzzy', score: bestScore, needsConfirmation: true };
  }

  return NO_MATCH;
}

/** Build a new Speaker record from a name discovered during import. */
export function makeSpeaker(name: string, role: SpeakerRole, successionOrder?: number): Speaker {
  const clean = unflipSortName(stripHonorific(name)).replace(/\s+/g, ' ').trim();
  const speaker: Speaker = {
    id: speakerSlug(clean),
    name: clean,
    sortName: toSortName(clean),
    role,
    aliases: defaultAliases(clean),
    gradientSeed: speakerSlug(clean),
  };
  if (successionOrder !== undefined) speaker.successionOrder = successionOrder;
  return speaker;
}

/** The alias forms this archive actually contains, generated rather than hand-listed. */
export function defaultAliases(name: string): string[] {
  const parts = name.split(/\s+/);
  const last = parts[parts.length - 1] ?? name;
  const set = new Set<string>([
    name,
    name.replace(/\./g, ''),
    toSortName(name),
    `President ${last}`,
    `Pres. ${last}`,
    `Elder ${last}`,
    `Sister ${last}`,
  ]);
  set.delete('');
  return [...set];
}

/** The sentinel used by `By Speaker/Others/All other Talks/` (§9.4). */
export const UNKNOWN_SPEAKER: Speaker = {
  id: 'unknown',
  name: 'Unknown',
  sortName: 'Unknown',
  role: 'other',
  aliases: [],
  gradientSeed: 'unknown',
};
