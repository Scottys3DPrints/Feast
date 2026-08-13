import { Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ChevronDown } from 'lucide-react-native';
import { formatDuration } from '@feast/core';
import { Artwork } from '../src/ui/Artwork';
import { EmptyState, Text } from '../src/ui/primitives';
import { useColors } from '../src/ui/theme';
import { space } from '../src/ui/tokens';
import { usePlayer } from '../src/player/store';

/**
 * Queue — SPEC §15.9.
 *
 * Now Playing pinned at the top, then Up Next. The JS-managed queue (§4.2 limit 2)
 * is the source of truth here, so this renders the player store rather than the
 * `queue` table until Phase 4 unifies them.
 *
 * Drag-to-reorder, swipe-to-remove and "Save as collection" arrive in Phase 4 with
 * the fractional `orderKey` writes (§12.4) — reordering without persisting the order
 * would be a lie the moment you leave the screen.
 */
export default function QueueScreen() {
  const colors = useColors();
  const router = useRouter();

  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.queueIndex);
  const current = usePlayer((s) => s.talk);
  const playTalk = usePlayer((s) => s.playTalk);

  const upNext = index >= 0 ? queue.slice(index + 1) : queue;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', height: 46, paddingHorizontal: space.gutter }}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
          <ChevronDown size={22} color={colors.textDim} strokeWidth={1.75} />
        </Pressable>
        <Text variant="title3" style={{ marginLeft: space.xs }}>
          Queue
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.xxl }}>
        {current ? (
          <>
            <Label>Now playing</Label>
            <Row title={current.title} subtitle={current.speakerName} seed={current.id} accent />
          </>
        ) : null}

        <Label>Up next</Label>
        {upNext.length ? (
          upNext.map((talk, i) => (
            <Pressable
              key={`${talk.id}:${i}`}
              onPress={() => void playTalk(talk, { queue, index: index + 1 + i })}
              accessibilityRole="button"
              accessibilityLabel={`Play ${talk.title}`}
            >
              <Row
                title={talk.title}
                subtitle={[talk.speakerName, formatDuration(talk.durationSec)].filter(Boolean).join(' · ')}
                seed={talk.id}
              />
            </Pressable>
          ))
        ) : (
          // §16 — empty states are instructions, never shrugs.
          <EmptyState title="Nothing up next" hint="Add talks by swiping right on any row." />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Label({ children }: { children: string }) {
  return (
    <Text
      variant="caption"
      color="faint"
      style={{ letterSpacing: 1.1, textTransform: 'uppercase', marginTop: space.md, marginBottom: 6 }}
    >
      {children}
    </Text>
  );
}

function Row({
  title,
  subtitle,
  seed,
  accent = false,
}: {
  title: string;
  subtitle: string;
  seed: string;
  accent?: boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.xs }}>
      <Artwork seed={seed} size={44} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="title2" numberOfLines={1} color={accent ? 'accent' : 'text'}>
          {title}
        </Text>
        <Text variant="label" color="dim" numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
    </View>
  );
}
