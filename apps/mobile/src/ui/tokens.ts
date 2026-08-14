/**
 * Design tokens — SPEC §14.
 *
 * Dark-first, because this app is used at night, while driving, and while falling
 * asleep. Light mode is a proper theme, not an afterthought.
 *
 * ACCENT DISCIPLINE (§14.1): brass gold marks *the currently playing thing* and *the
 * primary action*, nothing else. If everything is gold, nothing is. Reach for
 * `textDim` before you reach for `accent`.
 */

export const dark = {
  bg: '#0D0F14', // near-black, faint blue cast
  surface: '#151922',
  surface2: '#1E2430',
  border: '#2A3140',
  text: '#F2F4F8',
  textDim: '#98A2B3',
  textFaint: '#5A6478',
  accent: '#C9A227', // brass/gold — reverent, warm, not garish
  accentDim: '#8A6F1B',
  accentSoft: '#2A2413', // accent at 12% for chip backgrounds
  positive: '#4A9B7F', // downloaded / complete
  warning: '#D89B4A', // needs attention
  danger: '#C4574B', // evict / delete
  overlay: 'rgba(13,15,20,0.86)',
  /** Ink for text sitting *on* the accent — never white, which vibrates on gold. */
  onAccent: '#171200',
} as const;

export const light = {
  bg: '#FAF8F4', // warm parchment, not white
  surface: '#FFFFFF',
  surface2: '#F1EEE7',
  border: '#E2DCD1',
  text: '#1A1D24',
  textDim: '#5A6478',
  textFaint: '#8A93A3',
  accent: '#8A6F1B',
  accentDim: '#C9A227',
  accentSoft: '#F5EFDC',
  positive: '#2F7A61',
  warning: '#B87A28',
  danger: '#A63F35',
  overlay: 'rgba(250,248,244,0.9)',
  onAccent: '#FFFFFF',
} as const;

export type Palette = typeof dark;

/** §14.3 — spacing scale. Screen gutter 16, section gap 24. */
export const space = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
  xxxl: 64,
  gutter: 16,
  section: 24,
} as const;

/** §14.3 — radius. Artwork `md`. Sheets `xl` (top corners only). */
export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  full: 999,
} as const;

/**
 * §14.2 — two families. Serif for talk titles and speaker names, because it earns the
 * content a little gravity and distinguishes *content* from *chrome* at a glance.
 * Sans for everything else.
 */
export const fontFamily = {
  serif: 'SourceSerif4',
  serifBold: 'SourceSerif4-SemiBold',
  sans: 'Inter',
  sansMedium: 'Inter-Medium',
  sansSemibold: 'Inter-SemiBold',
  sansBold: 'Inter-Bold',
  mono: 'JetBrainsMono',
} as const;

export type TypeToken =
  | 'display'
  | 'title1'
  | 'title2'
  | 'title3'
  | 'body'
  | 'bodyRead'
  | 'label'
  | 'caption'
  | 'mono'
  | 'overline';

export interface TypeStyle {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing?: number;
}

/**
 * §14.2's table, with the optical corrections that only show up on a real screen.
 *
 * Two deliberate departures from the spec's numbers:
 *
 *  • `display` is 28/34, not 32/38. Source Serif has a large x-height, so 32 on a
 *    360dp-wide phone wraps a talk title like "Tomorrow the Lord Will Do Wonders" onto
 *    three lines and reads as shouting rather than as gravity.
 *  • Serif headings carry a small NEGATIVE letterSpacing. Serif faces at display sizes
 *    look loose by default; the spec's table is silent on tracking because it was
 *    written before anything was rendered.
 *
 * Line heights are ~1.2 for headings and ~1.5 for reading text, which is the ratio the
 * spec's own bodyRead (18/30) implies.
 */
export const type: Record<TypeToken, TypeStyle> = {
  display: { fontFamily: fontFamily.serifBold, fontSize: 28, lineHeight: 34, letterSpacing: -0.4 },
  title1: { fontFamily: fontFamily.serifBold, fontSize: 22, lineHeight: 28, letterSpacing: -0.3 },
  title2: { fontFamily: fontFamily.serifBold, fontSize: 17, lineHeight: 23, letterSpacing: -0.2 },
  title3: { fontFamily: fontFamily.sansSemibold, fontSize: 15, lineHeight: 20, letterSpacing: -0.1 },
  body: { fontFamily: fontFamily.sans, fontSize: 15, lineHeight: 23 },
  /** Transcript reader ONLY (§15.6). Long-form serif at a generous measure. */
  bodyRead: { fontFamily: fontFamily.serif, fontSize: 18, lineHeight: 30 },
  label: { fontFamily: fontFamily.sansMedium, fontSize: 13, lineHeight: 18 },
  caption: { fontFamily: fontFamily.sansMedium, fontSize: 11, lineHeight: 15, letterSpacing: 0.3 },
  mono: { fontFamily: fontFamily.mono, fontSize: 12, lineHeight: 17 },
  /** Section headers: small, tracked-out sans caps. The chrome voice (§14.2). */
  overline: {
    fontFamily: fontFamily.sansSemibold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.2,
  },
};

/**
 * §14.3 — motion. The mini→full player transition is a shared-element on the artwork,
 * driven with Reanimated directly rather than a bottom sheet, for control over feel.
 * All of it must respect `prefers-reduced-motion`.
 */
export const motion = {
  standardMs: 220,
  /** cubic-bezier(0.2, 0, 0, 1) */
  standardEasing: [0.2, 0, 0, 1] as const,
  sheetSpring: { damping: 22, stiffness: 220 },
  sheetMs: 320,
} as const;

/**
 * §14.3 / §16 — touch targets ≥ 44×44 always; player transport ≥ 64×64, because it
 * gets used in a car and in a pocket.
 */
export const hit = {
  min: 44,
  transport: 64,
} as const;

/**
 * §6.1 `artworkColor` / `Speaker.gradientSeed`: a deterministic two-stop gradient so
 * the fallback is never ugly and never random between launches. §21 Q7 recommends
 * shipping these instead of sourcing 34 portraits.
 */
export function gradientFor(seed: string): [string, string] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;

  // Hues are constrained to the muted, reverent band the mockup uses — indigo through
  // plum, brass, teal, and clay. A free 0–360 hue picks up neon greens and hot pinks.
  const hues = [218, 268, 38, 168, 355, 208];
  const hue = hues[h % hues.length]!;
  const sat = 24 + (h % 14);
  return [`hsl(${hue}, ${sat}%, 32%)`, `hsl(${hue}, ${sat + 6}%, 16%)`];
}
