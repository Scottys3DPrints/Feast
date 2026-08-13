import { Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft, MoreHorizontal, Pin, Play } from 'lucide-react-native';
import { formatBytes, formatDuration } from '@feast/core';
import { getTalk } from '../../src/db/queries';
import { useDbQuery } from '../../src/db/useDbQuery';
import { toNowPlaying } from '../../src/features/TalkRow';
import { Artwork } from '../../src/ui/Artwork';
import { Button, Chip, Text } from '../../src/ui/primitives';
import { ResidencyBadge } from '../../src/ui/ResidencyBadge';
import { useColors } from '../../src/ui/theme';
import { space } from '../../src/ui/tokens';
import { usePlayer } from '../../src/player/store';
import { sqlite } from '../../src/db/client';

/**
 * Talk detail — SPEC §15.6.
 *
 * The transcript below the fold is the feature that makes this a gospel-study app
 * rather than a podcast app: a talk becomes something both listenable and studyable.
 * Rendered in `bodyRead` (serif, 18/30) — the one place that token is used (§14.2).
 */
export default function TalkDetailScreen() {
  const colors = useColors();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const talk = useDbQuery(() => (id ? getTalk(id) : null), [id]);
  const transcript = useDbQuery(() => (id ? readTranscript(id) : null), [id]);
  const playTalk = usePlayer((s) => s.playTalk);
  const seekTo = usePlayer((s) => s.seekTo);
  const nowPlayingId = usePlayer((s) => s.talk?.id);

  if (!talk) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg, padding: space.gutter }}>
        <Text variant="title2">This talk isn't in your library.</Text>
        <Text variant="body" color="dim" style={{ marginTop: space.xs }}>
          It may have been removed from OneDrive. Re-run `feast import` on your PC.
        </Text>
      </SafeAreaView>
    );
  }

  const paragraphs = transcript ? splitParagraphs(transcript) : [];

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View
        style={{
          height: 46,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: space.gutter,
        }}
      >
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back">
          <ChevronLeft size={22} color={colors.textDim} strokeWidth={1.75} />
        </Pressable>
        <Pressable hitSlop={12} accessibilityRole="button" accessibilityLabel="More options">
          <MoreHorizontal size={20} color={colors.textDim} strokeWidth={1.75} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.xxl }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Artwork uri={talk.artworkPath} seed={talk.speakerId ?? talk.id} color={talk.artworkColor} size={84} />
          <View style={{ flex: 1, minWidth: 0, paddingTop: 2 }}>
            <Text variant="title1" numberOfLines={3}>
              {talk.title}
            </Text>
            <Pressable
              onPress={() => talk.speakerId && router.push(`/speaker/${talk.speakerId}`)}
              accessibilityRole="link"
            >
              <Text variant="title3" color="accent" style={{ marginTop: 6 }}>
                {talk.speakerName}
              </Text>
            </Pressable>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 5 }}>
              <ResidencyBadge state={talk.residency} size={14} />
              <Text variant="mono" color="faint">
                {[talk.eventName, formatDuration(talk.durationSec), formatBytes(talk.sizeBytes)]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
          </View>
        </View>

        <View style={{ flexDirection: 'row', gap: space.xs, marginTop: space.md }}>
          <Button
            title={nowPlayingId === talk.id ? 'Playing' : 'Play'}
            icon={<Play size={16} color={colors.onAccent} fill={colors.onAccent} />}
            onPress={() => void playTalk(toNowPlaying(talk))}
            style={{ flex: 2 }}
          />
          {/* Pinning lands in Phase 3 with the CacheManager (§11.3). */}
          <Button
            title="Pin"
            kind="ghost"
            icon={<Pin size={16} color={colors.text} strokeWidth={1.75} />}
            style={{ flex: 1 }}
            disabled
          />
        </View>

        <View style={{ flexDirection: 'row', gap: 6, marginTop: space.sm, flexWrap: 'wrap' }}>
          {talk.rating ? <Chip label={'★'.repeat(talk.rating)} selected /> : null}
          {talk.played ? <Chip label="Played" /> : null}
          {talk.sessionName ? <Chip label={talk.sessionName} /> : null}
        </View>

        {paragraphs.length ? (
          <>
            <Text
              variant="caption"
              color="faint"
              style={{
                letterSpacing: 1.1,
                textTransform: 'uppercase',
                marginTop: space.lg,
                marginBottom: space.xs,
              }}
            >
              Transcript
            </Text>

            {paragraphs.map((paragraph, i) => (
              <Pressable
                key={i}
                // §13: tapping seeks to an ESTIMATE derived from word position. The
                // honest accuracy is ±60–90 s on a 20-minute talk, so this is "take me
                // near it", not "take me to it". Word-accurate alignment is Phase 6.
                onPress={() => {
                  const estimate = estimatePosition(paragraphs, i, talk.durationSec ?? 0);
                  void seekTo(Math.max(0, estimate - 20));
                }}
                accessibilityRole="button"
                accessibilityLabel={`Jump to this paragraph. Approximate.`}
              >
                <Text variant="bodyRead" color="dim" style={{ marginTop: space.sm }}>
                  {paragraph}
                </Text>
              </Pressable>
            ))}

            <Text variant="caption" color="faint" style={{ marginTop: space.md, lineHeight: 16 }}>
              Tap any paragraph to jump near it in the audio. Positions are estimated from word
              counts, so expect to land within a minute or two.
            </Text>
          </>
        ) : (
          <Text variant="caption" color="faint" style={{ marginTop: space.lg, lineHeight: 16 }}>
            No transcript for this talk yet. General Conference and BYU Speeches ship with one; for
            the rest, run `feast transcribe` on your PC.
          </Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function readTranscript(talkId: string): string | null {
  const row = sqlite.getFirstSync<{ transcript: string | null }>(
    'SELECT transcript FROM talks WHERE id = ?',
    [talkId],
  );
  return row?.transcript ?? null;
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);
}

/**
 * §13 step 2–3: count WORDS, not characters, and scale by the spoken total.
 * The ±20 s lead-in is applied by the caller, per the spec's step 3.
 */
function estimatePosition(paragraphs: string[], index: number, durationSec: number): number {
  if (durationSec <= 0) return 0;
  const words = paragraphs.map((p) => p.split(/\s+/).length);
  const total = words.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  const before = words.slice(0, index).reduce((a, b) => a + b, 0);
  return (before / total) * durationSec;
}
