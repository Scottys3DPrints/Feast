import { useState } from 'react';
import { Dimensions, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  ChevronDown,
  Clock,
  ListMusic,
  MoreHorizontal,
  Pause,
  Play,
  Bookmark,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
} from 'lucide-react-native';
import { formatDuration } from '@feast/core';
import { Artwork } from '../src/ui/Artwork';
import { Text } from '../src/ui/primitives';
import { useColors } from '../src/ui/theme';
import { hit, radius, space } from '../src/ui/tokens';
import { playbackSettings, usePlayer } from '../src/player/store';

/**
 * Full-screen player — SPEC §15.7.
 *
 * Transport controls are ≥ 64×64 because this gets used in a car and in a pocket
 * (§14.3), and the scrubber is an `adjustable` accessibility element with 15 s
 * increments (§16).
 *
 * ⚠️ Skip is asymmetric on purpose: −15 s back, +30 s forward (§11.5). Back is for
 * "what did he just say"; forward is for skipping an anecdote.
 */

const RATES = [0.8, 1, 1.2, 1.5, 1.75, 2, 2.5, 3];

export default function PlayerScreen() {
  const colors = useColors();
  const router = useRouter();

  const talk = usePlayer((s) => s.talk);
  const status = usePlayer((s) => s.status);
  const position = usePlayer((s) => s.position);
  const duration = usePlayer((s) => s.duration);
  const buffering = usePlayer((s) => s.buffering);
  const rate = usePlayer((s) => s.rate);
  const error = usePlayer((s) => s.error);
  const toggle = usePlayer((s) => s.toggle);
  const seekRelative = usePlayer((s) => s.seekRelative);
  const seekTo = usePlayer((s) => s.seekTo);
  const setRate = usePlayer((s) => s.setRate);
  const next = usePlayer((s) => s.next);
  const previous = usePlayer((s) => s.previous);
  const retry = usePlayer((s) => s.retry);

  const [scrubWidth, setScrubWidth] = useState(1);

  if (!talk) {
    router.back();
    return null;
  }

  const art = Math.min(Dimensions.get('window').width - space.gutter * 2 - 40, 280);
  const progress = duration > 0 ? Math.min(1, position / duration) : 0;
  const playing = status === 'playing';

  const cycleRate = () => {
    const i = RATES.indexOf(rate);
    setRate(RATES[(i + 1) % RATES.length] ?? 1);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <View
        style={{
          height: 46,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: space.gutter,
        }}
      >
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close player">
          <ChevronDown size={22} color={colors.textDim} strokeWidth={1.75} />
        </Pressable>
        <Pressable hitSlop={12} accessibilityRole="button" accessibilityLabel="More options">
          <MoreHorizontal size={20} color={colors.textDim} strokeWidth={1.75} />
        </Pressable>
      </View>

      <View style={{ flex: 1, alignItems: 'center', paddingHorizontal: space.gutter }}>
        <Artwork
          uri={talk.artworkPath}
          seed={talk.id}
          color={talk.artworkColor}
          size={art}
          style={{
            shadowColor: '#000',
            shadowOpacity: 0.55,
            shadowRadius: 40,
            shadowOffset: { width: 0, height: 16 },
            elevation: 12,
          }}
        />

        <Text variant="display" style={{ marginTop: space.lg, textAlign: 'center' }} numberOfLines={3}>
          {talk.title}
        </Text>
        <Pressable
          onPress={() => router.push(`/talk/${talk.id}`)}
          accessibilityRole="link"
          accessibilityLabel={`More from ${talk.speakerName}`}
        >
          <Text variant="title3" color="accent" style={{ marginTop: space.xs }}>
            {talk.speakerName}
          </Text>
        </Pressable>
        {talk.eventName ? (
          <Text variant="caption" color="faint" style={{ marginTop: 4, textAlign: 'center' }}>
            {[talk.eventName, talk.sessionName].filter(Boolean).join(' · ')}
          </Text>
        ) : null}

        {/* §16 — an honest, actionable error, with a retry that works. */}
        {error ? (
          <Pressable
            onPress={() => void retry()}
            accessibilityRole="button"
            style={{
              marginTop: space.md,
              borderRadius: radius.sm,
              borderWidth: 1,
              borderColor: colors.warning,
              padding: space.xs,
            }}
          >
            <Text variant="caption" color="warning" style={{ textAlign: 'center' }}>
              {error}
            </Text>
            <Text variant="caption" color="accent" style={{ textAlign: 'center', marginTop: 4 }}>
              Tap to retry
            </Text>
          </Pressable>
        ) : null}

        {/* Scrubber. `adjustable` with 15 s increments, per §16. */}
        <View
          style={{ width: '100%', marginTop: space.lg }}
          onLayout={(e) => setScrubWidth(Math.max(1, e.nativeEvent.layout.width))}
        >
          <Pressable
            accessibilityRole="adjustable"
            accessibilityLabel="Playback position"
            accessibilityValue={{ text: `${formatDuration(position)} of ${formatDuration(duration)}` }}
            accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
            onAccessibilityAction={(e) => {
              void seekRelative(e.nativeEvent.actionName === 'increment' ? 15 : -15);
            }}
            onPress={(e) => {
              if (duration <= 0) return;
              void seekTo((e.nativeEvent.locationX / scrubWidth) * duration);
            }}
            hitSlop={12}
          >
            <View style={{ height: 3, borderRadius: 2, backgroundColor: colors.surface2 }}>
              <View
                style={{
                  width: `${progress * 100}%`,
                  height: '100%',
                  borderRadius: 2,
                  backgroundColor: colors.accent,
                }}
              />
            </View>
          </Pressable>

          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 7 }}>
            <Text variant="mono" color="dim">
              {formatDuration(position)}
            </Text>
            <Text variant="mono" color="dim">
              {buffering ? 'buffering…' : `−${formatDuration(Math.max(0, duration - position))}`}
            </Text>
          </View>
        </View>

        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: space.md,
            marginTop: space.lg,
          }}
        >
          <Transport label="Previous" onPress={() => void previous()}>
            <SkipBack size={20} color={colors.textDim} strokeWidth={1.75} />
          </Transport>
          <Transport label={`Back ${playbackSettings.skipBackSec} seconds`} onPress={() => void seekRelative(-playbackSettings.skipBackSec)}>
            <RotateCcw size={22} color={colors.textDim} strokeWidth={1.75} />
          </Transport>

          <Pressable
            onPress={toggle}
            accessibilityRole="button"
            accessibilityLabel={playing ? 'Pause' : 'Play'}
            style={{
              width: 64,
              height: 64,
              borderRadius: 32,
              backgroundColor: colors.accent,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {playing ? (
              <Pause size={26} color={colors.onAccent} fill={colors.onAccent} />
            ) : (
              <Play size={26} color={colors.onAccent} fill={colors.onAccent} style={{ marginLeft: 3 }} />
            )}
          </Pressable>

          <Transport label={`Forward ${playbackSettings.skipForwardSec} seconds`} onPress={() => void seekRelative(playbackSettings.skipForwardSec)}>
            <RotateCw size={22} color={colors.textDim} strokeWidth={1.75} />
          </Transport>
          <Transport label="Next" onPress={() => void next()}>
            <SkipForward size={20} color={colors.textDim} strokeWidth={1.75} />
          </Transport>
        </View>

        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            width: '100%',
            marginTop: space.lg,
            paddingHorizontal: space.xs,
          }}
        >
          <Pressable onPress={cycleRate} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Speed ${rate}x`}>
            <Text variant="label" color="dim">
              {rate}×
            </Text>
          </Pressable>
          <FooterAction icon={<Clock size={16} color={colors.textDim} strokeWidth={1.75} />} label="Sleep" />
          <FooterAction icon={<Bookmark size={16} color={colors.textDim} strokeWidth={1.75} />} label="Bookmark" />
          <FooterAction
            icon={<ListMusic size={16} color={colors.textDim} strokeWidth={1.75} />}
            label="Queue"
            onPress={() => router.push('/queue')}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

function Transport({
  children,
  label,
  onPress,
}: {
  children: React.ReactNode;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      // §14.3 — ≥ 64×64 for transport, so it stays hittable at arm's length in a car.
      style={{ width: hit.transport, height: hit.transport, alignItems: 'center', justifyContent: 'center' }}
    >
      {children}
    </Pressable>
  );
}

function FooterAction({
  icon,
  label,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  onPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}
    >
      {icon}
      <Text variant="label" color="dim">
        {label}
      </Text>
    </Pressable>
  );
}
