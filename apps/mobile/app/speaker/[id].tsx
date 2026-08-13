import { Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft, Play, Shuffle } from 'lucide-react-native';
import { formatDuration } from '@feast/core';
import { sqlite } from '../../src/db/client';
import { talksBySpeaker } from '../../src/db/queries';
import { useDbQuery } from '../../src/db/useDbQuery';
import { TalkRow, toNowPlaying } from '../../src/features/TalkRow';
import { Artwork } from '../../src/ui/Artwork';
import { Button, EmptyState, Text } from '../../src/ui/primitives';
import { useColors } from '../../src/ui/theme';
import { space } from '../../src/ui/tokens';
import { usePlayer } from '../../src/player/store';

/**
 * Speaker detail — SPEC §15.4.
 *
 * Portrait header, role, succession number for prophets, and the stats line
 * (`117 talks · 42 heard · 31h 12m total`) that makes a speaker page feel like a body
 * of work rather than a filter result.
 *
 * "Pin all (with size)" is deliberately absent until Phase 3 — §3 principle 3 says
 * every action that consumes disk states the number first, and there is no CacheManager
 * yet to compute it honestly.
 */
export default function SpeakerScreen() {
  const colors = useColors();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const speaker = useDbQuery(() => (id ? readSpeaker(id) : null), [id]);
  const talks = useDbQuery(() => (id ? talksBySpeaker(id) : []), [id]) ?? [];
  const playTalk = usePlayer((s) => s.playTalk);

  const heard = talks.filter((t) => t.played).length;
  const totalSec = talks.reduce((sum, t) => sum + (t.durationSec ?? 0), 0);

  const playAll = (shuffle: boolean) => {
    if (!talks.length) return;
    const queue = shuffle ? [...talks].sort(() => Math.random() - 0.5) : talks;
    void playTalk(toNowPlaying(queue[0]!), { queue: queue.map(toNowPlaying), index: 0 });
  };

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', height: 46, paddingHorizontal: space.gutter }}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back">
          <ChevronLeft size={22} color={colors.textDim} strokeWidth={1.75} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.xxl }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
          <Artwork
            uri={speaker?.photo_path}
            seed={speaker?.gradient_seed ?? id ?? 'unknown'}
            size={72}
            rounded
          />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="title1" numberOfLines={2}>
              {speaker?.name ?? 'Unknown speaker'}
            </Text>
            <Text variant="label" color="dim" style={{ marginTop: 4 }}>
              {talks.length} talks · {heard} heard · {formatDuration(totalSec)} total
            </Text>
          </View>
        </View>

        <View style={{ flexDirection: 'row', gap: space.xs, marginTop: space.md }}>
          <Button
            title="Play all"
            icon={<Play size={16} color={colors.onAccent} fill={colors.onAccent} />}
            onPress={() => playAll(false)}
            style={{ flex: 1 }}
          />
          <Button
            title="Shuffle"
            kind="ghost"
            icon={<Shuffle size={16} color={colors.text} strokeWidth={1.75} />}
            onPress={() => playAll(true)}
            style={{ flex: 1 }}
          />
        </View>

        <View style={{ marginTop: space.md }}>
          {talks.length ? (
            talks.map((talk, i) => <TalkRow key={talk.id} talk={talk} queue={talks} index={i} />)
          ) : (
            <EmptyState title="No talks yet" hint="Run `feast import` on your PC to build the catalog." />
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function readSpeaker(id: string) {
  return sqlite.getFirstSync<{
    id: string;
    name: string;
    role: string;
    succession_order: number | null;
    photo_path: string | null;
    gradient_seed: string;
  }>('SELECT id, name, role, succession_order, photo_path, gradient_seed FROM speakers WHERE id = ?', [id]);
}
