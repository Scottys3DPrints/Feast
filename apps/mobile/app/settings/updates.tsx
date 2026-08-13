import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ChevronLeft, Download, RefreshCw } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { formatBytes } from '@feast/core';
import {
  checkForUpdate,
  currentVersionCode,
  currentVersionName,
  downloadAndInstall,
  type UpdateCheck,
  type UpdateManifest,
} from '../../src/updates/selfUpdate';
import { Button, Card, Divider, Text } from '../../src/ui/primitives';
import { useColors } from '../../src/ui/theme';
import { radius, space } from '../../src/ui/tokens';

/**
 * Settings → Updates.
 *
 * One button, and it tells the truth at every step. §16: "Errors are honest and
 * actionable" — an update screen that says "failed" without saying what to do is the
 * exact thing that rule exists to prevent, because the user's only other option is
 * plugging into a laptop, which is what this screen exists to avoid.
 */
export default function UpdatesScreen() {
  const colors = useColors();
  const router = useRouter();

  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState<{ written: number; total: number } | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  const runCheck = useCallback(async () => {
    setChecking(true);
    setInstallError(null);
    const result = await checkForUpdate();
    setCheck(result);
    setChecking(false);
    if (result.status === 'available') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, []);

  // Check on open. The button is for retrying, not for the happy path — making the
  // user press something before they can learn there is nothing to press is silly.
  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  const install = useCallback(
    async (manifest: UpdateManifest) => {
      setInstallError(null);
      setProgress({ written: 0, total: manifest.sizeBytes ?? 0 });
      try {
        await downloadAndInstall(manifest, ({ bytesWritten, totalBytes }) =>
          setProgress({ written: bytesWritten, total: totalBytes }),
        );
        // Android's installer is now in front. If the user confirms, this process is
        // replaced mid-sentence; if they cancel, they come back to this screen with
        // the progress bar full, which reads correctly as "downloaded, not installed".
      } catch (e) {
        setInstallError(e instanceof Error ? e.message : 'The update could not be installed.');
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      } finally {
        setProgress(null);
      }
    },
    [],
  );

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', height: 46, paddingHorizontal: space.gutter }}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back">
          <ChevronLeft size={22} color={colors.textDim} strokeWidth={1.75} />
        </Pressable>
        <Text variant="title3" style={{ marginLeft: space.xs }}>
          Updates
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.xxl }}>
        <Card>
          <Text variant="label" color="dim">
            Installed
          </Text>
          <Text variant="title2" style={{ marginTop: 2 }}>
            Feast {currentVersionName()}
          </Text>
          <Text variant="caption" color="faint" style={{ marginTop: 4 }}>
            build {currentVersionCode()}
          </Text>
        </Card>

        <View style={{ marginTop: space.md }}>
          {checking ? (
            <Row>
              <ActivityIndicator color={colors.accent} />
              <Text variant="body" color="dim">
                Checking for updates…
              </Text>
            </Row>
          ) : progress ? (
            <DownloadProgressView written={progress.written} total={progress.total} />
          ) : (
            <Result check={check} onInstall={install} onRetry={runCheck} />
          )}
        </View>

        {installError ? (
          <Text variant="body" style={{ color: colors.danger, marginTop: space.sm }}>
            {installError}
          </Text>
        ) : null}

        {!checking && !progress ? (
          <Button
            title="Check again"
            kind="ghost"
            icon={<RefreshCw size={16} color={colors.text} strokeWidth={1.75} />}
            style={{ marginTop: space.md }}
            onPress={() => void runCheck()}
          />
        ) : null}

        <Divider />
        <Text variant="caption" color="faint" style={{ lineHeight: 18 }}>
          Updates install over the existing app, so your library, ratings, bookmarks and
          listening positions are kept. Android will ask you to confirm the install and,
          the first time, to allow Feast to install apps.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Result({
  check,
  onInstall,
  onRetry,
}: {
  check: UpdateCheck | null;
  onInstall: (m: UpdateManifest) => void;
  onRetry: () => void;
}) {
  const colors = useColors();
  if (!check) return null;

  switch (check.status) {
    case 'available':
      return (
        <Card>
          <Text variant="label" color="accent">
            Update available
          </Text>
          <Text variant="title2" style={{ marginTop: 2 }}>
            Feast {check.manifest.versionName}
          </Text>
          <Text variant="caption" color="faint" style={{ marginTop: 4 }}>
            build {check.manifest.versionCode}
            {check.manifest.sizeBytes ? ` · ${formatBytes(check.manifest.sizeBytes)}` : ''}
            {check.manifest.releasedAt ? ` · ${check.manifest.releasedAt}` : ''}
          </Text>
          {check.manifest.notes ? (
            <Text variant="body" color="dim" style={{ marginTop: space.sm }}>
              {check.manifest.notes}
            </Text>
          ) : null}
          <Button
            title="Download and install"
            icon={<Download size={16} color={colors.onAccent} strokeWidth={2} />}
            style={{ marginTop: space.sm }}
            onPress={() => onInstall(check.manifest)}
          />
        </Card>
      );

    case 'up-to-date':
      return (
        <Text variant="body" color="dim">
          Feast is up to date.
        </Text>
      );

    case 'not-configured':
      return (
        <Text variant="body" color="dim">
          No update source is configured for this build. Set{' '}
          <Text variant="body" color="accent">
            EXPO_PUBLIC_UPDATE_MANIFEST_URL
          </Text>{' '}
          and rebuild.
        </Text>
      );

    case 'unsupported-platform':
      return (
        <Text variant="body" color="dim">
          In-app updates are Android only. On iOS, updates arrive through TestFlight.
        </Text>
      );

    case 'error':
      return (
        <Pressable onPress={onRetry}>
          <Text variant="body" style={{ color: colors.warning }}>
            {check.message}
          </Text>
          <Text variant="caption" color="faint" style={{ marginTop: 4 }}>
            Tap to try again.
          </Text>
        </Pressable>
      );
  }
}

function DownloadProgressView({ written, total }: { written: number; total: number }) {
  const colors = useColors();
  const pct = total > 0 ? Math.min(1, written / total) : 0;
  return (
    <View>
      <Text variant="body" color="dim">
        Downloading… {formatBytes(written)}
        {total > 0 ? ` of ${formatBytes(total)}` : ''}
      </Text>
      <View
        style={{
          height: 4,
          borderRadius: radius.sm,
          backgroundColor: colors.surface2,
          overflow: 'hidden',
          marginTop: space.xs,
        }}
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(pct * 100) }}
      >
        <View style={{ width: `${pct * 100}%`, height: '100%', backgroundColor: colors.accent }} />
      </View>
      <Text variant="caption" color="faint" style={{ marginTop: space.xs }}>
        Keep Feast open until Android's installer appears.
      </Text>
    </View>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>{children}</View>;
}
