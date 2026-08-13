import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Pause, Play } from 'lucide-react-native';
import { Artwork } from '../ui/Artwork';
import { Text } from '../ui/primitives';
import { useColors } from '../ui/theme';
import { hit, space } from '../ui/tokens';
import { usePlayer } from '../player/store';

/**
 * The mini player — SPEC §15.8.
 *
 * A persistent 60 px bar above the tab bar with a hairline progress line along the top
 * edge. Tap expands to the full player; the shared-element artwork transition (§14.3)
 * is what ties the two together and is why the artwork keeps a stable `seed`.
 */
export function MiniPlayer() {
  const colors = useColors();
  const router = useRouter();
  const talk = usePlayer((s) => s.talk);
  const status = usePlayer((s) => s.status);
  const position = usePlayer((s) => s.position);
  const duration = usePlayer((s) => s.duration);
  const error = usePlayer((s) => s.error);
  const toggle = usePlayer((s) => s.toggle);
  const retry = usePlayer((s) => s.retry);

  if (!talk) return null;

  const progress = duration > 0 ? Math.min(1, position / duration) : 0;
  const playing = status === 'playing';

  return (
    <View
      style={{
        height: 60,
        backgroundColor: colors.surface2,
        borderTopWidth: 1,
        borderTopColor: colors.border,
      }}
    >
      {/* Hairline progress along the top edge (§15.8). */}
      <View
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          height: 2,
          width: `${progress * 100}%`,
          backgroundColor: colors.accent,
        }}
      />

      <Pressable
        onPress={() => router.push('/player')}
        accessibilityRole="button"
        accessibilityLabel={`Now playing: ${talk.title} by ${talk.speakerName}. Open the player.`}
        style={{
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          paddingHorizontal: space.sm,
        }}
      >
        <Artwork
          uri={talk.artworkPath}
          seed={talk.id}
          color={talk.artworkColor}
          size={40}
        />

        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="title3" numberOfLines={1}>
            {talk.title}
          </Text>
          {/* §16 — an error here is honest and offers the way out, in the same space
              the speaker name would occupy, so the bar never changes height. */}
          {error ? (
            <Text variant="caption" color="warning" numberOfLines={1}>
              {error}
            </Text>
          ) : (
            <Text variant="caption" color="dim" numberOfLines={1}>
              {talk.speakerName}
            </Text>
          )}
        </View>

        <Pressable
          onPress={error ? () => void retry() : toggle}
          accessibilityRole="button"
          accessibilityLabel={error ? 'Retry' : playing ? 'Pause' : 'Play'}
          hitSlop={10}
          style={{
            width: hit.min,
            height: hit.min,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {playing ? (
            <Pause size={22} color={colors.accent} fill={colors.accent} strokeWidth={1.75} />
          ) : (
            <Play size={22} color={colors.accent} fill={colors.accent} strokeWidth={1.75} />
          )}
        </Pressable>
      </Pressable>
    </View>
  );
}
