import { useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { migrate } from '../src/db/client';
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

  useEffect(() => {
    try {
      migrate();
      // §12.3 — MMKV is ahead of SQLite whenever the app was killed mid-talk.
      reconcilePositions();
      setReady(true);
    } catch (error) {
      setFatal(error instanceof Error ? error.message : String(error));
    }
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
            {fatal ? <FatalError message={fatal} /> : ready ? <Routes /> : <Booting />}
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
