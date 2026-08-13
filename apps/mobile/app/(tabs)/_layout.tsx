import { View } from 'react-native';
import { Tabs } from 'expo-router';
import { Download, Home, Library, Search } from 'lucide-react-native';
import { MiniPlayer } from '../../src/features/MiniPlayer';
import { useColors } from '../../src/ui/theme';
import { fontFamily } from '../../src/ui/tokens';

/**
 * Tab shell — SPEC §10, §15.8.
 *
 * Home · Library · Search · Storage, with the mini player hosted ABOVE the tab bar
 * rather than inside a screen. That placement is what makes it persistent: navigating
 * between tabs must never interrupt or remount playback.
 */
export default function TabsLayout() {
  const colors = useColors();

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ flex: 1 }}>
        <Tabs
          screenOptions={{
            headerShown: false,
            tabBarStyle: {
              backgroundColor: colors.surface,
              borderTopColor: colors.border,
              height: 56,
            },
            tabBarActiveTintColor: colors.accent,
            tabBarInactiveTintColor: colors.textFaint,
            tabBarLabelStyle: { fontFamily: fontFamily.sansSemibold, fontSize: 10 },
            sceneStyle: { backgroundColor: colors.bg },
          }}
        >
          <Tabs.Screen
            name="index"
            options={{
              title: 'Home',
              tabBarIcon: ({ color }) => <Home size={20} color={color} strokeWidth={1.75} />,
            }}
          />
          <Tabs.Screen
            name="library"
            options={{
              title: 'Library',
              tabBarIcon: ({ color }) => <Library size={20} color={color} strokeWidth={1.75} />,
            }}
          />
          <Tabs.Screen
            name="search"
            options={{
              title: 'Search',
              tabBarIcon: ({ color }) => <Search size={20} color={color} strokeWidth={1.75} />,
            }}
          />
          <Tabs.Screen
            name="storage"
            options={{
              title: 'Storage',
              tabBarIcon: ({ color }) => <Download size={20} color={color} strokeWidth={1.75} />,
            }}
          />
        </Tabs>
      </View>
      <MiniPlayer />
    </View>
  );
}
