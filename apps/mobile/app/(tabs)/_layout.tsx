import { View } from 'react-native';
import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
 *
 * ⚠️ TWO THINGS HERE ARE LOAD-BEARING, and both were wrong once.
 *
 * 1. `paddingBottom: insets.bottom`. SDK 57 / RN 0.86 is edge-to-edge on Android and
 *    that is not optional (§4.8). A tab bar laid out to a fixed height therefore sits
 *    UNDERNEATH the system navigation bar, which happily eats every touch aimed at it.
 *    The app looks fine in a screenshot and is completely unnavigable on the device.
 *
 * 2. The mini player is pinned ABOVE the tab bar with an absolute offset of exactly the
 *    tab bar's height. Rendered as an ordinary sibling after <Tabs> it lands BELOW the
 *    tab bar — at the very bottom of the screen, in the same dead zone as (1).
 *    (Replacing the `tabBar` renderer would also work, but expo-router ships its own
 *    copy of the bottom-tabs types and the two do not typecheck against each other.)
 */
const TAB_BAR_BASE_HEIGHT = 58;

export default function TabsLayout() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const tabBarHeight = TAB_BAR_BASE_HEIGHT + insets.bottom;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Tabs
        screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: tabBarHeight,
          paddingBottom: insets.bottom + 6,
          paddingTop: 8,
          elevation: 0,
        },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarLabelStyle: {
          fontFamily: fontFamily.sansMedium,
          fontSize: 10,
          letterSpacing: 0.2,
          marginTop: 2,
        },
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color }) => <Home size={21} color={color} strokeWidth={1.75} />,
        }}
      />
      <Tabs.Screen
        name="library"
        options={{
          title: 'Library',
          tabBarIcon: ({ color }) => <Library size={21} color={color} strokeWidth={1.75} />,
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: 'Search',
          tabBarIcon: ({ color }) => <Search size={21} color={color} strokeWidth={1.75} />,
        }}
      />
      <Tabs.Screen
        name="storage"
        options={{
          title: 'Storage',
          tabBarIcon: ({ color }) => <Download size={21} color={color} strokeWidth={1.75} />,
          }}
        />
      </Tabs>

      <View style={{ position: 'absolute', left: 0, right: 0, bottom: tabBarHeight }}>
        <MiniPlayer />
      </View>
    </View>
  );
}
