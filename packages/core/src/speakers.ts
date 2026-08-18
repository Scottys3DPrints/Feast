/**
 * Speaker canonicalization — SPEC §9.4.
 *
 * "Russell M. Nelson", "Russell M Nelson", "President Nelson", "Pres. Nelson" and
 * "Nelson, Russell M." must all resolve to `russell-m-nelson`.
 *
 * ⚠️ Fuzzy matching NEVER silently merges. `resolveSpeaker` returns a confidence and
 * the caller decides; §9.4 requires a confirmation prompt for anything below `exact`.
 */
import type { Speaker, SpeakerRole } from './types';

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

// ─── Role classification for catalog talks ────────────────────────────────────────
//
// ⚠️ WHY A TABLE AND NOT A HEURISTIC.
//
// §9.4 derives role from the archive's folder structure — `By Speaker/Prophets/17 …`
// tells you both the role and the succession order for free. Catalog talks arrive from
// a public API with a display name and nothing else, so that signal does not exist and
// there is nothing to infer from: a talk's session does not imply the speaker's calling,
// and neither does its length or year.
//
// So this is a curated list, which is honest about being one. It is deliberately narrow:
// Presidents of the Church (whose succession order is a fact, not a judgement) and
// members of the Quorum of the Twelve. Everyone else stays `other` rather than being
// guessed at — a wrong calling is worse than an unstated one.
//
// Names are matched after canonicalization, so "President Nelson" and "Russell M Nelson"
// both resolve.

/** Presidents of the Church, by succession order. */
const PRESIDENTS: ReadonlyArray<readonly [number, string]> = [
  [1, 'Joseph Smith'],
  [2, 'Brigham Young'],
  [3, 'John Taylor'],
  [4, 'Wilford Woodruff'],
  [5, 'Lorenzo Snow'],
  [6, 'Joseph F. Smith'],
  [7, 'Heber J. Grant'],
  [8, 'George Albert Smith'],
  [9, 'David O. McKay'],
  [10, 'Joseph Fielding Smith'],
  [11, 'Harold B. Lee'],
  [12, 'Spencer W. Kimball'],
  [13, 'Ezra Taft Benson'],
  [14, 'Howard W. Hunter'],
  [15, 'Gordon B. Hinckley'],
  [16, 'Thomas S. Monson'],
  [17, 'Russell M. Nelson'],
];

/**
 * Members of the Quorum of the Twelve who appear in the archive.
 *
 * Includes those who later became President — the lookup checks PRESIDENTS first, so
 * the more specific role wins.
 */
const APOSTLES: readonly string[] = [
  'Dallin H. Oaks',
  'Henry B. Eyring',
  'Jeffrey R. Holland',
  'Dieter F. Uchtdorf',
  'David A. Bednar',
  'Quentin L. Cook',
  'D. Todd Christofferson',
  'Neil L. Andersen',
  'Ronald A. Rasband',
  'Gary E. Stevenson',
  'Dale G. Renlund',
  'Gerrit W. Gong',
  'Ulisses Soares',
  'Patrick Kearon',
  'Neal A. Maxwell',
  'Bruce R. McConkie',
  'Boyd K. Packer',
  'L. Tom Perry',
  'Richard G. Scott',
  'Robert D. Hales',
  'M. Russell Ballard',
  'Joseph B. Wirthlin',
  'James E. Faust',
  'Marvin J. Ashton',
  'Howard W. Hunter',
  'Mark E. Petersen',
  'LeGrand Richards',
  'Delbert L. Stapley',
  'Marion G. Romney',
  'Ezra Taft Benson',
  'Spencer W. Kimball',
  'Harold B. Lee',
];

const presidentByKey = new Map<string, number>(
  PRESIDENTS.map(([order, name]) => [speakerSlug(name), order]),
);
const apostleKeys = new Set<string>(APOSTLES.map((name) => speakerSlug(name)));

export interface RoleAssignment {
  role: SpeakerRole;
  successionOrder?: number;
}

/**
 * Classify a speaker by display name.
 *
 * Returns `other` for anyone not on the curated lists, which is most people and is the
 * correct answer — the alternative is inventing callings for 500 names.
 */
export function classifySpeaker(name: string): RoleAssignment {
  const cleaned = stripHonorific(normalizeName(name));
  const key = speakerSlug(cleaned);

  const order = presidentByKey.get(key);
  if (order !== undefined) return { role: 'prophet', successionOrder: order };
  if (apostleKeys.has(key)) return { role: 'apostle' };

  /*
   * Surname-only form ("President Nelson" → "Nelson"), which §9.4's alias table calls
   * out explicitly.
   *
   * ⚠️ Resolved ONLY when the surname is unambiguous across both lists. "Nelson" maps to
   * exactly one person; "Smith" maps to four Presidents alone, and guessing which would
   * attribute a talk to the wrong prophet. Ambiguity falls through to `other`, which is
   * merely unhelpful rather than wrong.
   */
  if (!cleaned.includes(' ')) {
    const matches = SURNAME_INDEX.get(key);
    if (matches?.length === 1) return matches[0]!;
  }

  return { role: 'other' };
}

/** surname slug → every role it could mean. Length > 1 means "refuse to guess". */
const SURNAME_INDEX: ReadonlyMap<string, RoleAssignment[]> = (() => {
  const index = new Map<string, RoleAssignment[]>();
  const add = (fullName: string, assignment: RoleAssignment) => {
    const key = speakerSlug(surname(fullName));
    const list = index.get(key);
    if (list) list.push(assignment);
    else index.set(key, [assignment]);
  };
  for (const [order, name] of PRESIDENTS) add(name, { role: 'prophet', successionOrder: order });
  for (const name of APOSTLES) {
    // Skip anyone already recorded as a President — the same human, the higher role.
    if (presidentByKey.has(speakerSlug(name))) continue;
    add(name, { role: 'apostle' });
  }
  return index;
})();
