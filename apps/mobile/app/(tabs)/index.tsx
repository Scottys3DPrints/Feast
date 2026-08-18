import { Pressable, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { AlertTriangle, ChevronRight, Play, Settings } from 'lucide-react-native';
import { formatBytes, formatDuration } from '@feast/core';
import {
  continueListening,
  countTalks,
  fromFiveStar,
  latestEvent,
  randomTalks,
  shortTalks,
  talksByEvent,
  topSpeakers,
  inProgress,
  libraryTotals,
  needsAttentionCount,
  recentlyAdded,
  upNext,
  type TalkListItem,
} from '../../src/db/queries';
import { useDbQuery } from '../../src/db/useDbQuery';
import { TalkRow, toNowPlaying } from '../../src/features/TalkRow';
import { Artwork } from '../../src/ui/Artwork';
import { Card, ProgressBar, SectionHeader, Text } from '../../src/ui/primitives';
import { ResidencyBadge } from '../../src/ui/ResidencyBadge';
import { useColors } from '../../src/ui/theme';
import { radius, space } from '../../src/ui/tokens';
import { usePlayer } from '../../src/player/store';
import { SafeAreaView } from 'react-native-safe-area-context';

/**
 * Home — SPEC §15.2. "Vertical, scannable, no clutter."
 *
 * The Needs Attention strip at the bottom is how `My List/_Redownload` stops being a
 * folder the user forgets about. It renders only when non-empty (§15.2), which is the
 * whole reason it earns a permanent slot.
 */
export default function HomeScreen() {
  const colors = useColors();
  const router = useRouter();

  const total = useDbQuery(() => countTalks(), []) ?? 0;
  const cont = useDbQuery(() => continueListening(), []);
  const next = useDbQuery(() => upNext(), []) ?? [];
  const started = useDbQuery(() => inProgress(6, cont?.id), [cont?.id]) ?? [];
  const recent = useDbQuery(() => recentlyAdded(), []) ?? [];
  const fiveStar = useDbQuery(() => fromFiveStar(), []) ?? [];
  const attention = useDbQuery(() => needsAttentionCount(), []) ?? 0;

  /*
   * Browse sections, for a library with no listening history yet.
   *
   * Every section above this point is driven by what you have already played, which
   * renders an almost-blank screen the day a 5,000-talk catalog first syncs. These give
   * Home something to offer on day one and quietly become less prominent as the
   * history-driven sections fill in.
   */
  const event = useDbQuery(() => latestEvent(), []);
  const eventTalks = useDbQuery(
    () => (event ? talksByEvent(event.eventName, 20) : []),
    [event?.eventName],
  ) ?? [];
  const speakers = useDbQuery(() => topSpeakers(14), []) ?? [];
  const shorts = useDbQuery(() => shortTalks(), []) ?? [];
  const surprise = useDbQuery(() => randomTalks(), []) ?? [];

  if (total === 0) return <EmptyLibrary />;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          paddingHorizontal: space.gutter,
          paddingTop: space.sm,
          paddingBottom: space.xs,
        }}
      >
        <View>
          <Text variant="overline" color="faint" style={{ textTransform: 'uppercase' }}>
            {greeting()}
          </Text>
          {/*
            The library's scale, stated plainly and computed at runtime (§15.1 / §19.1 —
            never hardcoded). It is also the product's whole promise in one line: all of
            this, none of it on your phone.
          */}
          <Text variant="display" style={{ marginTop: 4 }}>
            Feast
          </Text>
        </View>
        <Pressable
          onPress={() => router.push('/settings')}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Settings"
          style={{ paddingTop: space.xs }}
        >
          <Settings size={20} color={colors.textDim} strokeWidth={1.75} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.xxl }}
        showsVerticalScrollIndicator={false}
      >
        {cont ? (
          <>
            <SectionHeader title="Continue listening" />
            <ResumeCard talk={cont} />
          </>
        ) : null}

        {next.length ? (
          <>
            <SectionHeader title="Up next" action="See all →" onAction={() => router.push('/queue')} />
            <HorizontalRail talks={next} />
          </>
        ) : null}

        {started.length ? (
          <>
            <SectionHeader title="Pick up where you left off" />
            {started.map((talk, i) => (
              <TalkRow key={talk.id} talk={talk} queue={started} index={i} showProgress />
            ))}
          </>
        ) : null}

        {recent.length ? (
          <>
            <SectionHeader title="Recently added" action="See all →" onAction={() => router.push('/library')} />
            <HorizontalRail talks={recent} />
          </>
        ) : null}

        {fiveStar.length ? (
          <>
            <SectionHeader title="From your Greatest of All" />
            <HorizontalRail talks={fiveStar} />
          </>
        ) : null}

        {event && eventTalks.length ? (
          <>
            <SectionHeader
              title={event.eventName}
              action="See all →"
              onAction={() => router.push('/library')}
            />
            <HorizontalRail talks={eventTalks} />
          </>
        ) : null}

        {speakers.length ? (
          <>
            <SectionHeader title="Speakers" action="See all →" onAction={() => router.push('/library')} />
            <SpeakerRail speakers={speakers} />
          </>
        ) : null}

        {shorts.length ? (
          <>
            <SectionHeader title="Under 15 minutes" />
            <HorizontalRail talks={shorts} />
          </>
        ) : null}

        {surprise.length ? (
          <>
            <SectionHeader title="Something to listen to" />
            <HorizontalRail talks={surprise} />
          </>
        ) : null}

        {attention > 0 ? (
          <Pressable
            onPress={() => router.push('/attention')}
            accessibilityRole="button"
            style={{
              marginTop: space.lg,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              backgroundColor: '#241C0F',
              borderColor: '#4A3A1C',
              borderWidth: 1,
              borderRadius: radius.md,
              padding: space.sm,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
              <AlertTriangle size={16} color={colors.warning} strokeWidth={1.75} />
              <Text variant="label" color="warning">
                {attention} {attention === 1 ? 'talk needs' : 'talks need'} attention
              </Text>
            </View>
            <ChevronRight size={16} color={colors.warning} strokeWidth={1.75} />
          </Pressable>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * The resume hero — §15.2's "large resume card", taken literally.
 *
 * This is the one place on Home that gets to be big. It is what the user wants 90% of
 * the times they open the app, so it is laid out as a hero rather than as the first row
 * of a list: large artwork, the title in display serif, and the only gold play button on
 * the screen (§14.1 — "if everything is gold, nothing is").
 */
function ResumeCard({ talk }: { talk: TalkListItem }) {
  const colors = useColors();
  const router = useRouter();
  const playTalk = usePlayer((s) => s.playTalk);
  const progress = talk.durationSec ? talk.positionSec / talk.durationSec : 0;
  const remaining = Math.max(0, (talk.durationSec ?? 0) - talk.positionSec);

  return (
    <Pressable
      onPress={() => router.push(`/talk/${talk.id}`)}
      accessibilityRole="button"
      accessibilityLabel={`${talk.title}, ${talk.speakerName}, ${formatDuration(remaining)} left`}
      style={{ flexDirection: 'row', gap: space.md, alignItems: 'center' }}
    >
      <Artwork
        uri={talk.artworkPath}
        seed={talk.speakerId ?? talk.id}
        color={talk.artworkColor}
        size={96}
      />

      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="title1" numberOfLines={3}>
          {talk.title}
        </Text>
        <Text variant="label" color="accent" numberOfLines={1} style={{ marginTop: 6 }}>
          {talk.speakerName}
        </Text>

        <View style={{ marginTop: space.sm }}>
          <ProgressBar progress={progress} />
        </View>

        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 6,
          }}
        >
          {/*
            "8:04 left" rather than "14:32 / 21:40". The wireframe shows elapsed/total,
            but the question being answered here is "can I finish this before I arrive",
            and remaining time answers it without arithmetic.
          */}
          <Text variant="mono" color="faint">
            {formatDuration(remaining)} left
          </Text>
          <ResidencyBadge state={talk.residency} />
        </View>
      </View>

      <Pressable
        onPress={() => void playTalk(toNowPlaying(talk))}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={`Resume ${talk.title}`}
        style={{
          width: 52,
          height: 52,
          borderRadius: 26,
          backgroundColor: colors.accent,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Play size={22} color={colors.onAccent} fill={colors.onAccent} strokeWidth={0} />
      </Pressable>
    </Pressable>
  );
}

/** Circular speaker chips — the fastest way into a library this size. */
function SpeakerRail({
  speakers,
}: {
  speakers: { id: string; name: string; count: number; color: string }[];
}) {
  const router = useRouter();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
      {speakers.map((s) => (
        <Pressable
          key={s.id}
          onPress={() => router.push(`/speaker/${s.id}`)}
          accessibilityRole="button"
          accessibilityLabel={`${s.name}, ${s.count} talks`}
          style={{ width: 92, alignItems: 'center' }}
        >
          <Artwork seed={s.id} color={s.color} size={72} rounded />
          <Text variant="caption" numberOfLines={2} style={{ marginTop: 6, textAlign: 'center' }}>
            {s.name}
          </Text>
          <Text variant="caption" color="faint">
            {s.count}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function HorizontalRail({ talks }: { talks: TalkListItem[] }) {
  const router = useRouter();
  const playTalk = usePlayer((s) => s.playTalk);

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
      {talks.map((talk, i) => (
        <Pressable
          key={talk.id}
          onPress={() => router.push(`/talk/${talk.id}`)}
          accessibilityRole="button"
          accessibilityLabel={`${talk.title}, ${talk.speakerName}`}
          style={{ width: 128 }}
        >
          <Pressable
            onPress={() => void playTalk(toNowPlaying(talk), { queue: talks.map(toNowPlaying), index: i })}
            accessibilityLabel={`Play ${talk.title}`}
          >
            <Artwork
              uri={talk.artworkPath}
              seed={talk.speakerId ?? talk.id}
              color={talk.artworkColor}
              size={128}
            />
          </Pressable>
          {/*
            Serif for the title, sans for the speaker. That pairing is the entire §14.2
            idea in miniature — content gets the serif voice, chrome gets the sans one —
            and at rail size it is what stops these reading as generic podcast tiles.
          */}
          <Text variant="title2" numberOfLines={2} style={{ marginTop: space.xs }}>
            {talk.title}
          </Text>
          <Text variant="caption" color="dim" numberOfLines={1} style={{ marginTop: 2 }}>
            {talk.speakerName}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

/**
 * §15.1: when there is no `catalog.json`, show setup instructions with a copyable
 * command — and deliberately DO NOT offer an in-app first scan. Doing that on-device
 * would mean shipping delta enumeration, filename parsing and the §9.4 mapping table
 * on the phone, triggering exactly the throttling §4.4 warns about, to duplicate a
 * tool that already exists.
 */
function EmptyLibrary() {
  const colors = useColors();
  const router = useRouter();
  const totals = useDbQuery(() => libraryTotals(), []);

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: space.gutter, gap: space.sm }}>
        <Text variant="title1" style={{ marginTop: space.lg }}>
          Your library is waiting on your PC
        </Text>
        <Text variant="body" color="dim">
          Feast reads a catalog that the desktop tool builds from your OneDrive archive. Run these on
          the computer where your Talks folder lives, then pull to refresh here.
        </Text>

        <View
          style={{
            backgroundColor: colors.surface,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: radius.md,
            padding: space.sm,
            gap: 6,
            marginTop: space.xs,
          }}
        >
          <Text variant="mono" color="accent">
            npm i -g feast
          </Text>
          <Text variant="mono" color="accent">
            feast login
          </Text>
          <Text variant="mono" color="accent">
            feast init
          </Text>
          <Text variant="mono" color="accent">
            feast import
          </Text>
        </View>

        {totals && totals.bytes > 0 ? (
          <Text variant="caption" color="faint">
            Last known: {totals.talks} talks · {formatBytes(totals.bytes)}
          </Text>
        ) : null}

        <Pressable
          onPress={() => router.push('/dev-browse')}
          accessibilityRole="button"
          style={{ marginTop: space.lg }}
        >
          <Text variant="label" color="accent">
            Browse OneDrive directly →
          </Text>
          <Text variant="caption" color="faint" style={{ marginTop: 2 }}>
            Phase 1 harness: lists one folder and streams from it, without a catalog.
          </Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
