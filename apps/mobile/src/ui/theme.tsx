import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { dark, light, type Palette } from './tokens';

/**
 * Theme plumbing — SPEC §14, §15.13 (Appearance: dark / light / system).
 *
 * Dark is the default rather than the fallback: `useColorScheme()` returns null on a
 * cold start before the OS reports, and null must land on dark, not light. A flash of
 * parchment at 2 a.m. is exactly the failure this app should not have.
 */

export type ThemePreference = 'dark' | 'light' | 'system';

interface ThemeValue {
  colors: Palette;
  scheme: 'dark' | 'light';
}

const ThemeContext = createContext<ThemeValue>({ colors: dark, scheme: 'dark' });

export function ThemeProvider({
  children,
  preference = 'system',
}: {
  children: ReactNode;
  preference?: ThemePreference;
}) {
  const system = useColorScheme();

  const value = useMemo<ThemeValue>(() => {
    const scheme: 'dark' | 'light' =
      preference === 'system' ? (system === 'light' ? 'light' : 'dark') : preference;
    return { colors: scheme === 'light' ? (light as unknown as Palette) : dark, scheme };
  }, [preference, system]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  return useContext(ThemeContext);
}

export function useColors(): Palette {
  return useContext(ThemeContext).colors;
}
