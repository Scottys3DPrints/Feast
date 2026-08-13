import { View } from 'react-native';
import { AlertCircle, Check, Cloud, Loader, Pin } from 'lucide-react-native';
import { useColors } from './theme';

/**
 * The residency badge — SPEC §14.5.
 *
 * "Every talk row shows exactly one residency indicator. Users learn it in a day."
 * This tiny component is how the whole Cloud Library / Pocket Cache idea (§2) becomes
 * legible at a glance, so the rules are strict:
 *
 *   • EXACTLY ONE badge per row. Never two, never zero.
 *   • ☁ hollow cloud, textFaint — in the catalog, not on this device. Tap to stream.
 *   • ⬤ filled check, positive — auto-cached. Plays offline. May be evicted.
 *   • 📌 pin, accent — pinned. Guaranteed offline.
 *   • ⟳ ring, accent — downloading.
 *   • ⚠ warning — needs attention.
 *
 * §16 requires VoiceOver to announce residency in the row label, so this carries its
 * own `accessibilityLabel` and rows compose it into theirs.
 */

export type Residency = 'cloud' | 'cached' | 'pinned' | 'downloading' | 'attention';

export const RESIDENCY_LABEL: Record<Residency, string> = {
  cloud: 'in your library, not downloaded',
  cached: 'downloaded',
  pinned: 'pinned, always available offline',
  downloading: 'downloading',
  attention: 'needs attention',
};

export function ResidencyBadge({ state, size = 16 }: { state: Residency; size?: number }) {
  const colors = useColors();

  const icon = (() => {
    switch (state) {
      case 'cloud':
        return <Cloud size={size} color={colors.textFaint} strokeWidth={1.75} />;
      case 'cached':
        return <Check size={size} color={colors.positive} strokeWidth={2.25} />;
      case 'pinned':
        return <Pin size={size} color={colors.accent} strokeWidth={1.75} fill={colors.accent} />;
      case 'downloading':
        return <Loader size={size} color={colors.accent} strokeWidth={1.75} />;
      case 'attention':
        return <AlertCircle size={size} color={colors.warning} strokeWidth={1.75} />;
    }
  })();

  return (
    <View
      accessible
      accessibilityLabel={RESIDENCY_LABEL[state]}
      style={{ width: 20, alignItems: 'center', justifyContent: 'center' }}
    >
      {icon}
    </View>
  );
}

/**
 * Derive the badge from cache state. Kept next to the component so there is one
 * definition of the mapping rather than one per screen.
 *
 * `pinned` outranks everything because it is the strongest guarantee; `attention`
 * outranks `cached` because a corrupt file that plays silence is worse than an
 * uncertain one that admits it.
 */
export function residencyOf(input: {
  pinned?: boolean;
  cacheState?: 'pending' | 'downloading' | 'complete' | 'failed' | null;
  needsAttention?: boolean;
}): Residency {
  if (input.needsAttention || input.cacheState === 'failed') return 'attention';
  if (input.pinned) return 'pinned';
  if (input.cacheState === 'downloading' || input.cacheState === 'pending') return 'downloading';
  if (input.cacheState === 'complete') return 'cached';
  return 'cloud';
}
