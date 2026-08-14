import { memo } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { radius } from './tokens';
import { gradientFor } from './tokens';

/**
 * Talk / speaker artwork with a deterministic gradient fallback — SPEC §9.2, §21 Q7.
 *
 * ⚠️ Artwork is extracted ONCE, at import, by the desktop tool. §9.2: "Do not attempt
 * artwork extraction at play time — that would require downloading the file, defeating
 * the entire architecture." So this component only ever renders a local file, a remote
 * URL the caller already resolved, or the gradient.
 *
 * The gradient is not a placeholder-of-shame: §21 recommends shipping generated
 * gradients rather than sourcing 34 portraits, because they look intentional and ship
 * instantly. Seeded from the speaker id, so a speaker's colour never changes.
 *
 * `recyclingKey` is required, not optional — §17 targets 60 fps over 2,000 rows and
 * without it expo-image will flash the previous row's image during recycling.
 */
export const Artwork = memo(function Artwork({
  uri,
  seed,
  size = 44,
  rounded = false,
  color,
  style,
}: {
  /** Local `file://` path or an already-resolved URL. Undefined ⇒ gradient. */
  uri?: string | null;
  /** Speaker id or talk id — determines the gradient. */
  seed: string;
  size?: number;
  /** Speakers render as circles (§15.3); talks as `md`-radius squares (§14.3). */
  rounded?: boolean;
  /** `Talk.artworkColor`, when the import computed a dominant colour. */
  color?: string | null;
  style?: StyleProp<ViewStyle>;
}) {
  const borderRadius = rounded ? size / 2 : size >= 96 ? radius.lg : radius.md;
  const [from, to] = color ? [color, shade(color, -0.45)] : gradientFor(seed);

  return (
    <View style={[{ width: size, height: size, borderRadius, overflow: 'hidden' }, style]}>
      {/*
        Three stops rather than two, with the midpoint pulled off-centre. A flat two-stop
        diagonal reads as "unstyled div"; the extra stop gives the square a light source
        and makes a generated gradient look chosen rather than defaulted (§21 Q7).
      */}
      <LinearGradient
        colors={[shade(from, 0.12), from, to]}
        locations={[0, 0.45, 1]}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        style={{ position: 'absolute', inset: 0 }}
      />
      {uri ? (
        <Image
          source={{ uri }}
          recyclingKey={seed}
          contentFit="cover"
          transition={120}
          style={{ width: '100%', height: '100%' }}
        />
      ) : null}
      {/*
        A hairline inset highlight. On a near-black background an unbordered square
        dissolves into the page; this separates artwork from ground without a visible
        frame, which is what "reverent, not precious" (§3.5) asks for.
      */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius,
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.10)',
        }}
      />
    </View>
  );
});

/** Darken/lighten a `#rrggbb`. Only used for the second stop of a dominant colour. */
function shade(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(((n >> 16) & 0xff) * (1 + amount));
  const g = clamp(((n >> 8) & 0xff) * (1 + amount));
  const b = clamp((n & 0xff) * (1 + amount));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}
