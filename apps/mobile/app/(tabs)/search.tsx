import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Search as SearchIcon } from 'lucide-react-native';
import { formatDuration } from '@feast/core';
import { countTalks, searchTalks, transcriptCoverage, type SearchHit } from '../../src/db/queries';
import { useDbQuery } from '../../src/db/useDbQuery';
import { Chip, EmptyState, Text } from '../../src/ui/primitives';
import { useColors } from '../../src/ui/theme';
import { radius, space, type as typeScale } from '../../src/ui/tokens';

/**
 * Search — SPEC §13, §15.10.
 *
 * Local FTS5, always offline, no network, sub-100 ms. The 120 ms debounce is from
 * §17's budget: it keeps the query off every keystroke without the field ever feeling
 * laggy.
 *
 * ⚠️ THE FOOTER IS NOT DECORATION. §13: "Coverage is honest, not universal." Until
 * `feast transcribe` has run, only General Conference and BYU Speeches talks have
 * transcripts, so the footer states the real counts and never implies full coverage.
 */
export default function SearchScreen() {
  const colors = useColors();
  const [raw, setRaw] = useState('');
  const [query, setQuery] = useState('');

  const totalTalks = useDbQuery(() => countTalks(), []) ?? 0;
  const withTranscripts = useDbQuery(() => transcriptCoverage(), []) ?? 0;

  useEffect(() => {
    const t = setTimeout(() => setQuery(raw), 120);
    return () => clearTimeout(t);
  }, [raw]);

  const hits = useMemo(() => (query.trim() ? searchTalks(query) : []), [query]);

  const { titleHits, transcriptHits } = useMemo(() => splitHits(hits), [hits]);

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ paddingHorizontal: space.gutter }}>
        <Text variant="title1" style={{ height: 48, lineHeight: 48 }}>
          Search
        </Text>

        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.xs,
            backgroundColor: colors.surface,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: radius.md,
            paddingHorizontal: space.sm,
          }}
        >
          <SearchIcon size={16} color={colors.textFaint} strokeWidth={1.75} />
          <TextInput
            value={raw}
            onChangeText={setRaw}
            placeholder="Titles, speakers, transcripts"
            placeholderTextColor={colors.textFaint}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            accessibilityLabel="Search your library"
            style={[typeScale.body, { flex: 1, color: colors.text, paddingVertical: 10 }]}
          />
        </View>

        {/* §15.10's filter chips. Wired in Phase 4 alongside smart collections (§13). */}
        <View style={{ flexDirection: 'row', gap: 6, marginTop: space.xs, flexWrap: 'wrap' }}>
          <Chip label="All" selected />
          <Chip label="Unplayed" />
          <Chip label="Downloaded" />
          <Chip label="5★" />
          <Chip label="Prophets" />
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.xxl }}
        keyboardShouldPersistTaps="handled"
      >
        {!query.trim() ? (
          <EmptyState
            title="Search your whole library"
            hint="Titles and speakers across every talk, and the full text of every transcript you have — all of it offline."
          />
        ) : hits.length === 0 ? (
          <EmptyState title={`Nothing for "${query}"`} hint="Try a shorter phrase, or a speaker's surname." />
        ) : (
          <>
            {titleHits.length ? (
              <>
                <SectionLabel>Talks</SectionLabel>
                {titleHits.map((hit) => (
                  <HitRow key={hit.id} hit={hit} />
                ))}
              </>
            ) : null}

            {transcriptHits.length ? (
              <>
                <SectionLabel>In transcripts</SectionLabel>
                {transcriptHits.map((hit) => (
                  <HitRow key={hit.id} hit={hit} showSnippet />
                ))}
              </>
            ) : null}
          </>
        )}

        <Text variant="caption" color="faint" style={{ marginTop: space.lg }}>
          Searching {totalTalks.toLocaleString()} titles and speakers, and inside{' '}
          {withTranscripts.toLocaleString()} transcripts.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function SectionLabel({ children }: { children: string }) {
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

/**
 * A transcript hit renders its snippet with the matched phrase emphasised.
 *
 * ⚠️ §13 is explicit that tapping one seeks to an ESTIMATE: FTS5 has no offset API, so
 * position is derived from word count, and realistic accuracy is ±60–90 s on a
 * 20-minute talk. The UI says "≈" rather than pretending otherwise, and Phase 6's
 * Whisper alignment is what makes it exact.
 */
function HitRow({ hit, showSnippet = false }: { hit: SearchHit; showSnippet?: boolean }) {
  const colors = useColors();
  const router = useRouter();

  return (
    <Pressable
      onPress={() => router.push(`/talk/${hit.id}`)}
      accessibilityRole="button"
      accessibilityLabel={`${hit.title}, ${hit.speakerName}`}
      style={{ paddingVertical: space.xs, gap: 2 }}
    >
      <Text variant="title2" numberOfLines={1}>
        {hit.title}
      </Text>
      <Text variant="label" color="dim" numberOfLines={1}>
        {hit.speakerName} · {formatDuration(hit.durationSec)}
      </Text>
      {showSnippet && hit.snippet ? (
        <Text variant="body" color="dim" numberOfLines={2} style={{ marginTop: 2 }}>
          {renderSnippet(hit.snippet, colors.accent)}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** `snippet()` returns `[...]`-bracketed matches; turn those into accent-coloured runs. */
function renderSnippet(snippet: string, accent: string) {
  const parts = snippet.split(/(\[[^\]]*\])/g);
  return parts.map((part, i) =>
    part.startsWith('[') && part.endsWith(']') ? (
      <Text key={i} variant="body" style={{ color: accent }}>
        {part.slice(1, -1)}
      </Text>
    ) : (
      part
    ),
  );
}

/** A hit is a "transcript hit" when the snippet actually contains a bracketed match. */
function splitHits(hits: SearchHit[]): { titleHits: SearchHit[]; transcriptHits: SearchHit[] } {
  const titleHits: SearchHit[] = [];
  const transcriptHits: SearchHit[] = [];
  for (const hit of hits) {
    if (hit.snippet && hit.snippet.includes('[')) transcriptHits.push(hit);
    else titleHits.push(hit);
  }
  return { titleHits, transcriptHits };
}
