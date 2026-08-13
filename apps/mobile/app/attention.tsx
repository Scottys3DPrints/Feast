import { Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { sqlite } from '../src/db/client';
import { useDbQuery } from '../src/db/useDbQuery';
import { EmptyState, Text } from '../src/ui/primitives';
import { useColors } from '../src/ui/theme';
import { space } from '../src/ui/tokens';

/**
 * Needs Attention — SPEC §15.14.
 *
 * The cleanup surface for everything the import couldn't be sure about. Sections are
 * collapsible and EMPTY BY DEFAULT — this screen should normally have nothing to say.
 *
 * The actions (queue re-download, pick a speaker, inline-edit a title) write user
 * overrides to `state.json` and are re-applied after every catalog sync, so a later
 * `feast import` never undoes a correction. That write path lands in Phase 4 with the
 * outbox (§12.2); until then this reports honestly and does not pretend to fix.
 */

interface AttentionRow {
  id: string;
  title: string;
  speakerName: string;
  flags: string;
  parseConfidence: number;
  missingSince: number | null;
}

export default function AttentionScreen() {
  const colors = useColors();
  const router = useRouter();

  const rows = useDbQuery(() => readAttention(), []) ?? [];

  const sections: { title: string; hint: string; items: AttentionRow[] }[] = [
    {
      title: 'Needs re-downloading',
      hint: 'From My List/_Redownload. Queue a re-download and the desktop tool fetches a clean copy.',
      items: rows.filter((r) => r.flags.includes('needs-redownload')),
    },
    {
      title: 'Unknown speaker',
      hint: 'The import couldn’t attribute these. Pick a speaker, or create one.',
      items: rows.filter((r) => r.flags.includes('needs-attribution')),
    },
    {
      title: 'Low-confidence titles',
      hint: 'The filename parser wasn’t sure. Edit the title, speaker, series, or part number.',
      items: rows.filter((r) => r.parseConfidence < 0.7),
    },
    {
      title: 'Failed downloads',
      hint: 'These stopped partway. Retry, or clear them and stream instead.',
      items: rows.filter((r) => r.flags.includes('download-failed')),
    },
    {
      title: 'Unplayable format',
      hint: 'Neither iOS nor Android can play these. Run `feast transcode` to convert them.',
      items: rows.filter((r) => r.flags.includes('unplayable-format')),
    },
    {
      title: 'Missing files',
      hint: 'In your library but not in OneDrive. Re-run `feast import`, or remove them.',
      items: rows.filter((r) => r.missingSince !== null),
    },
  ].filter((s) => s.items.length > 0);

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', height: 46, paddingHorizontal: space.gutter }}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back">
          <ChevronLeft size={22} color={colors.textDim} strokeWidth={1.75} />
        </Pressable>
        <Text variant="title3" style={{ marginLeft: space.xs }}>
          Needs attention
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.xxl }}>
        {sections.length === 0 ? (
          <EmptyState
            title="Nothing needs attention"
            hint="When the import isn't sure about a title, a speaker, or a file, it lands here instead of quietly being wrong."
          />
        ) : (
          sections.map((section) => (
            <View key={section.title} style={{ marginTop: space.md }}>
              <Text variant="title3">{section.title}</Text>
              <Text variant="caption" color="faint" style={{ marginTop: 2, lineHeight: 16 }}>
                {section.hint}
              </Text>
              {section.items.map((item) => (
                <View key={item.id} style={{ paddingVertical: 6 }}>
                  <Text variant="title2" numberOfLines={1}>
                    {item.title}
                  </Text>
                  <Text variant="label" color="dim" numberOfLines={1}>
                    {item.speakerName || 'Unknown speaker'}
                  </Text>
                </View>
              ))}
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function readAttention(): AttentionRow[] {
  return sqlite.getAllSync<AttentionRow>(
    `SELECT id, title, speaker_name AS speakerName, flags,
            parse_confidence AS parseConfidence, missing_since AS missingSince
     FROM talks
     WHERE missing_since IS NOT NULL
        OR parse_confidence < 0.7
        OR flags LIKE '%needs-redownload%'
        OR flags LIKE '%needs-attribution%'
        OR flags LIKE '%download-failed%'
        OR flags LIKE '%unplayable-format%'
     ORDER BY title
     LIMIT 500`,
  );
}
