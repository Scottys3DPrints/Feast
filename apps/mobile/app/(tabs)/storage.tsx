import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Paths } from 'expo-file-system';
import { formatBytes } from '@feast/core';
import {
  cachedTalks,
  libraryTotals,
  storageTotals,
  type CachedTalkRow,
} from '../../src/db/queries';
import { useDbQuery } from '../../src/db/useDbQuery';
import { Button, Card, Text } from '../../src/ui/primitives';
import { ResidencyBadge } from '../../src/ui/ResidencyBadge';
import { useColors } from '../../src/ui/theme';
import { radius, space } from '../../src/ui/tokens';

/**
 * Storage — SPEC §15.11. "The screen that sells the concept."
 *
 * §2: "The user must always be able to answer 'what is on my phone right now and why'
 * in two taps." Which is why this is a first-class tab rather than a settings row.
 *
 * ⚠️ THE BAR HAS TWO SEGMENTS AND ONLY ONE IS MEASURED AGAINST THE BUDGET (§11.3
 * rule 3). Pinned bytes are unbounded and reported separately — counting them against
 * a 2 GB budget would mean pinning a 1.1 GB collection instantly evicts everything
 * else, which is the opposite of what pinning promises.
 */

/** §11.3 — default 2 GB, user-settable 500 MB – 50 GB. Wired to settings in Phase 3. */
const DEFAULT_BUDGET_BYTES = 2 * 1024 ** 3;

export default function StorageScreen() {
  const colors = useColors();

  const totals = useDbQuery(() => storageTotals(), []);
  const library = useDbQuery(() => libraryTotals(), []);
  const pinned = useDbQuery(() => cachedTalks(true), []) ?? [];
  const cached = useDbQuery(() => cachedTalks(false), []) ?? [];

  const pinnedBytes = totals?.pinnedBytes ?? 0;
  const cachedBytes = totals?.cachedBytes ?? 0;
  const budget = DEFAULT_BUDGET_BYTES;
  const free = Paths.availableDiskSpace ?? 0;

  // The bar's scale is (pinned + budget), so the cached segment reads as a proportion
  // of its own budget while pinned still shows its true share of the whole.
  const scale = Math.max(1, pinnedBytes + budget);
  const pinnedPct = (pinnedBytes / scale) * 100;
  const cachedPct = (Math.min(cachedBytes, budget) / scale) * 100;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.xxl }}
        showsVerticalScrollIndicator={false}
      >
        <Text variant="title1" style={{ height: 48, lineHeight: 48 }}>
          Storage
        </Text>

        <Card>
          <View
            style={{
              flexDirection: 'row',
              height: 11,
              borderRadius: 6,
              overflow: 'hidden',
              backgroundColor: colors.surface2,
            }}
            accessible
            accessibilityLabel={`Pinned ${formatBytes(pinnedBytes)}, cached ${formatBytes(
              cachedBytes,
            )} of a ${formatBytes(budget)} budget`}
          >
            <View style={{ width: `${pinnedPct}%`, backgroundColor: colors.accent }} />
            <View style={{ width: `${cachedPct}%`, backgroundColor: colors.positive }} />
          </View>

          <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.xs, flexWrap: 'wrap' }}>
            <Legend color={colors.accent} label="Pinned" value={formatBytes(pinnedBytes)} />
            <Legend
              color={colors.positive}
              label="Cached"
              value={`${formatBytes(cachedBytes)} / ${formatBytes(budget)}`}
            />
          </View>

          <Text variant="caption" color="faint" style={{ marginTop: space.xs, lineHeight: 16 }}>
            {formatBytes(free)} free on device. Pinned talks aren't counted against the cache budget.
          </Text>
        </Card>

        <Card style={{ marginTop: space.xs }}>
          <StatRow label="Library in the cloud" value={`${formatBytes(library?.bytes ?? 0)} · ${library?.talks ?? 0}`} />
          <StatRow
            label="On this device"
            value={`${(totals?.pinnedCount ?? 0) + (totals?.cachedCount ?? 0)} talks`}
          />
        </Card>

        <View style={{ flexDirection: 'row', gap: space.xs, marginTop: space.xs }}>
          <Button title="Free up space" kind="ghost" style={{ flex: 1 }} disabled />
          <Button title="Change budget" kind="ghost" style={{ flex: 1 }} disabled />
        </View>

        <SectionLabel>Pinned</SectionLabel>
        {pinned.length ? (
          pinned.map((row) => <CacheRow key={`${row.talkId}:${row.rendition}`} row={row} />)
        ) : (
          <Text variant="body" color="dim">
            Nothing pinned yet. Pin a talk, a speaker, or a whole collection and it's guaranteed
            offline — you'll see the exact size before you commit.
          </Text>
        )}

        <SectionLabel>Auto-cached</SectionLabel>
        {cached.length ? (
          cached.map((row) => <CacheRow key={`${row.talkId}:${row.rendition}`} row={row} />)
        ) : (
          <Text variant="body" color="dim">
            Nothing cached yet. Anything you stream is kept here automatically so the second listen
            is offline and instant.
          </Text>
        )}

        {/* §2: "Eviction never loses anything… The UI should say so, once." */}
        <Text variant="caption" color="faint" style={{ marginTop: space.lg, lineHeight: 16 }}>
          Cached talks can be removed any time — they're always still in your library and one tap
          from playing again.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Legend({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: color }} />
      <Text variant="caption" color="dim">
        {label} <Text variant="caption">{value}</Text>
      </Text>
    </View>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
      <Text variant="label" color="dim">
        {label}
      </Text>
      <Text variant="label">{value}</Text>
    </View>
  );
}

function CacheRow({ row }: { row: CachedTalkRow }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.xs,
        paddingVertical: 6,
      }}
    >
      <ResidencyBadge state={row.pinned ? 'pinned' : 'cached'} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="title2" numberOfLines={1}>
          {row.title}
        </Text>
        <Text variant="label" color="dim" numberOfLines={1}>
          {row.speakerName}
          {row.rendition === 'stream' ? ' · compact' : ''}
        </Text>
      </View>
      <Text variant="mono" color="faint">
        {formatBytes(row.bytes)}
      </Text>
    </View>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <Text
      variant="caption"
      color="faint"
      style={{
        letterSpacing: 1.1,
        textTransform: 'uppercase',
        marginTop: space.lg,
        marginBottom: 6,
      }}
    >
      {children}
    </Text>
  );
}
