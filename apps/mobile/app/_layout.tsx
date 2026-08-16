import { useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import {
  SourceSerif4_400Regular,
  SourceSerif4_600SemiBold,
  SourceSerif4_700Bold,
} from '@expo-google-fonts/source-serif-4';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import { JetBrainsMono_500Medium } from '@expo-google-fonts/jetbrains-mono';
import { migrate } from '../src/db/client';
import { seedDemoCatalogIfEmpty } from '../src/db/demoSeed';
import { reconcileCache } from '../src/cache/CacheManager';
import { reconcilePositions } from '../src/player/positionStore';
import { flushOnBackground } from '../src/player/store';
import { ThemeProvider, useColors } from '../src/ui/theme';
import { Text } from '../src/ui/primitives';
import { space } from '../src/ui/tokens';

/**
 * Root layout — SPEC §10.
 *
 * "Providers, DB migration gate, MiniPlayer host." The migration gate is a gate in the
 * literal sense: nothing renders until the schema is current, because every screen
 * queries tables that may not exist yet.
 */

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The catalog is local and authoritative (§3 principle 1); react-query here is
      // for network work only — URL minting and job polling — so aggressive refetching
      // would just spend Graph quota (§4.4).
      retry: 2,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);

  /**
   * §14.2's two families, loaded before anything paints.
   *
   * ⚠️ The keys here must match `fontFamily` in ui/tokens.ts EXACTLY. React Native does
   * not warn when a `fontFamily` names a font that was never registered — it silently
   * substitutes the system face. The symptom is an app that looks plausible and is
   * entirely missing its design: every serif renders as Roboto, and the serif/sans
   * distinction that separates content from chrome disappears without a single error.
   */
  const [fontsLoaded, fontError] = useFonts({
    SourceSerif4: SourceSerif4_400Regular,
    'SourceSerif4-SemiBold': SourceSerif4_600SemiBold,
    'SourceSerif4-Bold': SourceSerif4_700Bold,
    Inter: Inter_400Regular,
    'Inter-Medium': Inter_500Medium,
    'Inter-SemiBold': Inter_600SemiBold,
    'Inter-Bold': Inter_700Bold,
    JetBrainsMono: JetBrainsMono_500Medium,
  });

  useEffect(() => {
    /*
     * Only the SCHEMA is fatal.
     *
     * ⚠️ Everything after `migrate()` used to share its try/catch, which meant any
     * failure in seeding, position reconciliation or cache reconciliation took the
     * entire app down behind a "database failed to migrate" screen that named the wrong
     * culprit. A single malformed cache row did exactly that.
     *
     * The distinction is not cosmetic: without a schema there is nothing to render, so
     * that is worth a takeover. Housekeeping is best-effort by nature — a cache row we
     * cannot reconcile costs the user one stale badge, not the app.
     */
    try {
      migrate();
    } catch (error) {
      setFatal(error instanceof Error ? error.message : String(error));
      return;
    }

    for (const [label, step] of [
      // Scaffolding until Phase 2's `feast import` exists — no-ops the moment the
      // library has any real talk in it. See src/db/demoSeed.ts.
      ['seed', seedDemoCatalogIfEmpty],
      // §12.3 — MMKV is ahead of SQLite whenever the app was killed mid-talk.
      ['positions', reconcilePositions],
      // §11.3 — mandatory on Android, where a failed download leaves a partial file
      // that would otherwise play as corrupt media rather than re-download.
      ['cache', reconcileCache],
    ] as const) {
      try {
        step();
      } catch (error) {
        console.warn(`[startup] ${label} failed:`, error);
      }
    }

    setReady(true);
  }, []);

  // §12.3 — one of the four durable flush points.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background' || next === 'inactive') flushOnBackground();
    });
    return () => sub.remove();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            <StatusBar style="light" />
            {/*
              Fonts gate the first paint alongside the migration. A font error is not
              fatal — falling back to system faces is ugly but usable, and refusing to
              start over a missing typeface would be worse than the typeface.
            */}
            {fatal ? (
              <FatalError message={fatal} />
            ) : ready && (fontsLoaded || fontError) ? (
              <Routes />
            ) : (
              <Booting />
            )}
          </QueryClientProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function Routes() {
  const colors = useColors();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="talk/[id]" options={{ presentation: 'card' }} />
      {/* §15.7 — the full player is a modal you swipe down to dismiss. */}
      <Stack.Screen
        name="player"
        options={{ presentation: 'modal', animation: 'slide_from_bottom', gestureEnabled: true }}
      />
    </Stack>
  );
}

function Booting() {
  const colors = useColors();
  return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
}

/**
 * The one error worth a full-screen takeover: a failed migration means the schema is
 * unusable and every other screen would throw a less legible version of this.
 */
function FatalError({ message }: { message: string }) {
  const colors = useColors();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.bg,
        padding: space.lg,
        justifyContent: 'center',
        gap: space.sm,
      }}
    >
      <Text variant="title1">Feast couldn't open its library</Text>
      <Text variant="body" color="dim">
        The on-device database failed to migrate. If this mentions "no such module: fts5", the app
        is running in Expo Go — full-text search needs a development build.
      </Text>
      <Text variant="mono" color="faint">
        {message}
      </Text>
    </View>
  );
}
