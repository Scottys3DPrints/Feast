import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { speakerList, talksPage, type SpeakerListItem, type TalkListItem } from '../../src/db/queries';
import { useDbQuery } from '../../src/db/useDbQuery';
import { TalkRow } from '../../src/features/TalkRow';
import { Artwork } from '../../src/ui/Artwork';
import { EmptyState, Text } from '../../src/ui/primitives';
import { useColors } from '../../src/ui/theme';
import { radius, space } from '../../src/ui/tokens';

/**
 * Library — SPEC §15.3.
 *
 * Segmented control across the top: Speakers · Collections · Series · All Talks.
 *
 * The Speakers segment is sectioned by role — prophets first, ordered by
 * `successionOrder` — which is `queries.speakerList()`'s ORDER BY rather than
 * anything computed here, so 2,000 rows never reach JS (§17).
 */

type Segment = 'speakers' | 'collections' | 'series' | 'all';

const SEGMENTS: { key: Segment; label: string }[] = [
  { key: 'speakers', label: 'Speakers' },
  { key: 'collections', label: 'Collections' },
  { key: 'series', label: 'Series' },
  { key: 'all', label: 'All' },
];

export default function LibraryScreen() {
  const colors = useColors();
  // §15.3: "Remembers the last segment." Phase 4 persists this to MMKV; for now it
  // survives navigation within a session, which is the part that matters day to day.
  const [segment, setSegment] = useState<Segment>('speakers');

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ paddingHorizontal: space.gutter }}>
        <Text variant="title1" style={{ height: 48, lineHeight: 48 }}>
          Library
        </Text>

        <View
          style={{
            flexDirection: 'row',
            backgroundColor: colors.surface2,
            borderRadius: radius.sm,
            padding: 2,
            marginBottom: space.xs,
          }}
        >
          {SEGMENTS.map(({ key, label }) => {
            const on = key === segment;
            return (
              <Pressable
                key={key}
                onPress={() => setSegment(key)}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                style={{
                  flex: 1,
                  alignItems: 'center',
                  paddingVertical: 7,
                  borderRadius: radius.sm - 2,
                  backgroundColor: on ? colors.surface : 'transparent',
                }}
              >
                <Text variant="caption" color={on ? 'text' : 'dim'}>
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {segment === 'speakers' ? <SpeakersList /> : null}
      {segment === 'all' ? <AllTalksList /> : null}
      {segment === 'collections' ? (
        <View style={{ paddingHorizontal: space.gutter }}>
          <EmptyState
            title="No collections yet"
            hint="Collections arrive with your catalog — _Greatest of All and the rest of My List become collections when the desktop tool imports them."
          />
        </View>
      ) : null}
      {segment === 'series' ? (
        <View style={{ paddingHorizontal: space.gutter }}>
          <EmptyState
            title="No series yet"
            hint="Lecture sets like 17 Points of the True Church become series, ordered by part number, once your catalog is imported."
          />
        </View>
      ) : null}
    </SafeAreaView>
  );
}

function SpeakersList() {
  const speakers = useDbQuery(() => speakerList(), []) ?? [];
  const router = useRouter();

  if (!speakers.length) {
    return (
      <View style={{ paddingHorizontal: space.gutter }}>
        <EmptyState title="No speakers yet" hint="Run `feast import` on your PC to build the catalog." />
      </View>
    );
  }

  return (
    <FlashList
      data={withRoleHeaders(speakers)}
      keyExtractor={(item) => (typeof item === 'string' ? `h:${item}` : item.id)}
      contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.xxl }}
      renderItem={({ item }) =>
        typeof item === 'string' ? (
          <Text
            variant="caption"
            color="faint"
            style={{ letterSpacing: 1.1, textTransform: 'uppercase', marginTop: space.md, marginBottom: 6 }}
          >
            {item}
          </Text>
        ) : (
          <SpeakerRow speaker={item} onPress={() => router.push(`/speaker/${item.id}`)} />
        )
      }
    />
  );
}

function SpeakerRow({ speaker, onPress }: { speaker: SpeakerListItem; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${speaker.name}, ${speaker.talkCount} talks, ${speaker.unplayedCount} unplayed`}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        paddingVertical: space.xs,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Artwork uri={speaker.photoPath} seed={speaker.gradientSeed} size={44} rounded />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="title2" numberOfLines={1}>
          {speaker.name}
        </Text>
        <Text variant="label" color="dim" numberOfLines={1}>
          {roleLabel(speaker)} · {speaker.talkCount} talks
        </Text>
      </View>
      {speaker.unplayedCount > 0 ? (
        <Text variant="caption" color="accent">
          {speaker.unplayedCount} new
        </Text>
      ) : null}
    </Pressable>
  );
}

/**
 * §15.3's All Talks: a FlashList over ~2,000 rows, fed by keyset pagination so scroll
 * depth costs nothing. FlashList v2 sizes automatically — there is no
 * `estimatedItemSize` any more (§4.8).
 */
function AllTalksList() {
  const first = useDbQuery(() => talksPage({ limit: 60 }), []) ?? [];
  const [extra, setExtra] = useState<TalkListItem[]>([]);
  const rows = [...first, ...extra];

  const loadMore = () => {
    const last = rows[rows.length - 1];
    if (!last) return;
    const nextPage = talksPage({ after: { title: last.title, id: last.id }, limit: 60 });
    if (nextPage.length) setExtra((prev) => [...prev, ...nextPage]);
  };

  if (!rows.length) {
    return (
      <View style={{ paddingHorizontal: space.gutter }}>
        <EmptyState title="No talks yet" hint="Run `feast import` on your PC to build the catalog." />
      </View>
    );
  }

  return (
    <FlashList
      data={rows}
      keyExtractor={(t) => t.id}
      contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.xxl }}
      onEndReachedThreshold={0.6}
      onEndReached={loadMore}
      renderItem={({ item, index }) => <TalkRow talk={item} queue={rows} index={index} />}
    />
  );
}

const ROLE_HEADINGS: Record<string, string> = {
  prophet: 'Prophets',
  apostle: 'Apostles',
  seventy: 'Seventy',
  auxiliary: 'Auxiliary',
  scholar: 'Scholars',
  other: 'Others',
};

/** Flatten into a single list with string section headers — one FlashList, no nesting. */
function withRoleHeaders(speakers: SpeakerListItem[]): (SpeakerListItem | string)[] {
  const out: (SpeakerListItem | string)[] = [];
  let lastRole: string | null = null;
  for (const speaker of speakers) {
    if (speaker.role !== lastRole) {
      out.push(ROLE_HEADINGS[speaker.role] ?? 'Others');
      lastRole = speaker.role;
    }
    out.push(speaker);
  }
  return out;
}

function roleLabel(speaker: SpeakerListItem): string {
  if (speaker.role === 'prophet' && speaker.successionOrder) {
    return `${ordinal(speaker.successionOrder)} President`;
  }
  if (speaker.role === 'apostle') return 'Quorum of the Twelve';
  return ROLE_HEADINGS[speaker.role]?.replace(/s$/, '') ?? 'Speaker';
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
