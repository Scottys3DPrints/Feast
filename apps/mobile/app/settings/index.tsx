import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Switch, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import * as Application from 'expo-application';
import { formatBytes } from '@feast/core';
import { CATALOG_VERSION } from '@feast/core';
import { clearTokens, getRedirectUri, isSignedIn, signIn } from '../../src/auth/msAuth';
import { getThrottledUntil, resetStorage } from '../../src/storage/provider';
import { getMeta } from '../../src/db/client';
import { libraryTotals } from '../../src/db/queries';
import { useDbQuery } from '../../src/db/useDbQuery';
import { Button, Divider, Text } from '../../src/ui/primitives';
import { useColors } from '../../src/ui/theme';
import { space } from '../../src/ui/tokens';
import { playbackSettings } from '../../src/player/store';
import { useAccount, useAccountActions } from '../../src/sync/useAccount';

/**
 * Settings — SPEC §15.13.
 *
 * Account · Playback · Downloads · Appearance · Library · About + diagnostics.
 *
 * The diagnostics block is not developer trivia: §16 requires throttling to be
 * surfaced rather than hidden, and "last sync / catalog version / throttling log" is
 * where a user finds out why the library looks stale.
 */
export default function SettingsScreen() {
  const colors = useColors();
  const router = useRouter();

  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [wifiOnly, setWifiOnly] = useState(playbackSettings.wifiOnlyDownloads);
  const [cellular, setCellular] = useState(playbackSettings.streamOnCellular);
  const totals = useDbQuery(() => libraryTotals(), []);
  const account = useAccount();
  const accountActions = useAccountActions();

  useEffect(() => {
    void isSignedIn().then(setSignedIn);
  }, []);

  const throttledUntil = getThrottledUntil();
  const lastSync = getMeta('last_catalog_sync');

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', height: 46, paddingHorizontal: space.gutter }}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back">
          <ChevronLeft size={22} color={colors.textDim} strokeWidth={1.75} />
        </Pressable>
        <Text variant="title3" style={{ marginLeft: space.xs }}>
          Settings
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.xxl }}>
        <Label>Account</Label>
        <Text variant="body" color="dim">
          {signedIn === null ? 'Checking…' : signedIn ? 'Connected to Microsoft.' : 'Not connected.'}
        </Text>
        <Text variant="caption" color="faint" style={{ marginTop: 4 }}>
          Library root: Talks
        </Text>
        {signedIn ? (
          <Button
            title="Sign out"
            kind="ghost"
            style={{ marginTop: space.xs }}
            onPress={() => {
              void clearTokens().then(() => {
                resetStorage();
                setSignedIn(false);
              });
            }}
          />
        ) : (
          <Button
            title="Sign in with Microsoft"
            style={{ marginTop: space.xs }}
            onPress={() => void signIn().then(setSignedIn)}
          />
        )}

        <Divider />
        <Label>Feast account</Label>
        {/*
          Separate from the Microsoft connection above, and deliberately so: Microsoft
          is where the AUDIO lives, this is where your lists live. Conflating them in
          one row would make signing out of one look like it signs out of both.
        */}
        {account.status === 'signed-in' ? (
          <>
            <Text variant="body" color="dim">
              Signed in. Your collections, ratings and bookmarks sync to every device you
              use this account on.
            </Text>
            <Button
              title="Sign out of Feast"
              kind="ghost"
              style={{ marginTop: space.xs }}
              onPress={() => void accountActions.signOut().catch(() => undefined)}
            />
          </>
        ) : account.status === 'unavailable' ? (
          <Text variant="body" color="dim">
            Sync isn't configured in this build. Your library still works — it just stays
            on this phone.
          </Text>
        ) : (
          <>
            <Text variant="body" color="dim">
              Create an account to keep your lists, ratings and progress across devices.
              Your library works without one.
            </Text>
            <Button
              title="Sign in or create account"
              style={{ marginTop: space.xs }}
              onPress={() => router.push('/(auth)/sign-in')}
            />
          </>
        )}

        <Divider />
        <Label>Downloads</Label>
        {/*
          §11.2's note, made literal in the UI: these are two switches, not one.
          Cellular streaming stays allowed while cellular downloads default off —
          collapsing them would double cellular data usage on every stream.
        */}
        <ToggleRow
          label="Download over Wi-Fi only"
          hint="Streaming on cellular is controlled separately, below."
          value={wifiOnly}
          onChange={(v) => {
            playbackSettings.wifiOnlyDownloads = v;
            setWifiOnly(v);
          }}
        />
        <ToggleRow
          label="Stream on cellular"
          hint="Off means talks only play when downloaded or on Wi-Fi."
          value={cellular}
          onChange={(v) => {
            playbackSettings.streamOnCellular = v;
            setCellular(v);
          }}
        />

        <Divider />
        <Label>Library</Label>
        <Text variant="body" color="dim">
          {totals?.talks ?? 0} talks · {formatBytes(totals?.bytes ?? 0)} in the cloud
        </Text>
        <Pressable onPress={() => router.push('/attention')} style={{ marginTop: space.xs }}>
          <Text variant="label" color="accent">
            Needs attention →
          </Text>
        </Pressable>

        <Divider />
        <Label>Updates</Label>
        <Text variant="body" color="dim">
          Feast {Application.nativeApplicationVersion ?? '—'} (build{' '}
          {Application.nativeBuildVersion ?? '—'})
        </Text>
        <Pressable onPress={() => router.push('/settings/updates')} style={{ marginTop: space.xs }}>
          <Text variant="label" color="accent">
            Check for updates →
          </Text>
        </Pressable>

        <Divider />
        <Label>Diagnostics</Label>
        <Text variant="caption" color="faint" style={{ lineHeight: 18 }}>
          Catalog schema: v{CATALOG_VERSION}
          {'\n'}Last catalog sync: {lastSync ? new Date(Number(lastSync)).toLocaleString() : 'never'}
          {'\n'}
          {throttledUntil
            ? `Syncing paused — OneDrive asked us to wait until ${new Date(throttledUntil).toLocaleTimeString()}.`
            : 'No throttling in this session.'}
          {'\n'}Redirect URI: {getRedirectUri()}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Label({ children }: { children: string }) {
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

function ToggleRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  const colors = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.xs }}>
      <View style={{ flex: 1 }}>
        <Text variant="body">{label}</Text>
        <Text variant="caption" color="faint" style={{ marginTop: 2 }}>
          {hint}
        </Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        accessibilityLabel={label}
        trackColor={{ true: colors.accentDim, false: colors.surface2 }}
        thumbColor={value ? colors.accent : colors.textFaint}
      />
    </View>
  );
}
