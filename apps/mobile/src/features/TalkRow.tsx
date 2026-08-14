import { memo } from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { formatDuration } from '@feast/core';
import { Artwork } from '../ui/Artwork';
import { ResidencyBadge, RESIDENCY_LABEL } from '../ui/ResidencyBadge';
import { ProgressBar, Text } from '../ui/primitives';
import { space } from '../ui/tokens';
import { usePlayer } from '../player/store';
import type { TalkListItem } from '../db/queries';

/**
 * The talk row — SPEC §16.
 *
 * "Tap = open detail, tap the artwork = play." §16 offers a choice between two
 * conventions and recommends this one, so it is applied consistently everywhere and
 * the artwork gets a distinct accessibility action rather than being decorative.
 *
 * Memoized because §17 targets 60 fps over 2,000 rows and an unmemoized row
 * re-renders on every progress tick of whatever is playing.
 */
export const TalkRow = memo(function TalkRow({
  talk,
  showProgress = false,
  queue,
  index,
}: {
  talk: TalkListItem;
  showProgress?: boolean;
  queue?: TalkListItem[];
  index?: number;
}) {
  const router = useRouter();
  const playTalk = usePlayer((s) => s.playTalk);
  const nowPlayingId = usePlayer((s) => s.talk?.id);
  const isCurrent = nowPlayingId === talk.id;

  const progress =
    talk.durationSec && talk.durationSec > 0 ? talk.positionSec / talk.durationSec : 0;

  const play = () => {
    void playTalk(toNowPlaying(talk), {
      ...(queue ? { queue: queue.map(toNowPlaying) } : {}),
      ...(index !== undefined ? { index } : {}),
    });
  };

  // Speaker carries the meaning; duration is a number you glance at. Splitting them into
  // two type styles rather than joining with " · " lets the eye skip the digits — at
  // 2,000 rows (§17) that difference is the whole scannability of the list.
  const duration = formatDuration(talk.durationSec);

  return (
    <Pressable
      onPress={() => router.push(`/talk/${talk.id}`)}
      accessibilityRole="button"
      // §16 — VoiceOver announces residency as part of the row.
      accessibilityLabel={`${talk.title}, ${talk.speakerName}, ${formatDuration(
        talk.durationSec,
      )}, ${RESIDENCY_LABEL[talk.residency]}`}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        paddingVertical: space.sm,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Pressable
        onPress={play}
        accessibilityRole="button"
        accessibilityLabel={`Play ${talk.title}`}
        hitSlop={4}
      >
        <Artwork
          uri={talk.artworkPath}
          seed={talk.speakerId ?? talk.id}
          color={talk.artworkColor}
          size={52}
        />
      </Pressable>

      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          variant="title2"
          numberOfLines={2}
          // §14.1 accent discipline: gold marks the currently playing thing, and this
          // is one of exactly two places that qualifies.
          color={isCurrent ? 'accent' : 'text'}
        >
          {talk.title}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
          <Text variant="label" color="dim" numberOfLines={1} style={{ flexShrink: 1 }}>
            {talk.speakerName}
          </Text>
          {duration ? (
            <Text variant="mono" color="faint">
              {duration}
            </Text>
          ) : null}
        </View>
        {showProgress && progress > 0.01 ? (
          <View style={{ marginTop: 8 }}>
            <ProgressBar progress={progress} />
          </View>
        ) : null}
      </View>

      <ResidencyBadge state={talk.residency} />
    </Pressable>
  );
});

export function toNowPlaying(talk: TalkListItem) {
  return {
    id: talk.id,
    title: talk.title,
    speakerName: talk.speakerName,
    archivePath: talk.archivePath,
    streamPath: talk.streamPath,
    artworkPath: talk.artworkPath,
    artworkColor: talk.artworkColor,
    durationSec: talk.durationSec,
    eventName: talk.eventName,
    sessionName: talk.sessionName,
  };
}
