import type { ReactNode } from 'react';
import {
  Pressable,
  ScrollView,
  Text as RNText,
  View,
  type PressableProps,
  type StyleProp,
  type TextProps as RNTextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useColors } from './theme';
import { hit, radius, space, type as typeScale, type TypeToken } from './tokens';

/**
 * UI primitives — the small vocabulary every screen is built from (SPEC §14).
 *
 * Deliberately not a utility-class library. §14 defines a *token* system (nine type
 * tokens, one accent rule, one spacing scale), and a token system expressed as typed
 * props catches "title2 but 17px" at compile time in a way class strings do not.
 */

// ─── Text ───────────────────────────────────────────────────────────────────────

type TextColor = 'text' | 'dim' | 'faint' | 'accent' | 'positive' | 'warning' | 'danger' | 'onAccent';

export interface TextProps extends RNTextProps {
  variant?: TypeToken;
  color?: TextColor;
  children?: ReactNode;
}

export function Text({ variant = 'body', color = 'text', style, ...rest }: TextProps) {
  const colors = useColors();
  const palette: Record<TextColor, string> = {
    text: colors.text,
    dim: colors.textDim,
    faint: colors.textFaint,
    accent: colors.accent,
    positive: colors.positive,
    warning: colors.warning,
    danger: colors.danger,
    onAccent: colors.onAccent,
  };
  return <RNText {...rest} style={[typeScale[variant], { color: palette[color] }, style]} />;
}

// ─── Layout ─────────────────────────────────────────────────────────────────────

export function Screen({
  children,
  scroll = false,
  style,
}: {
  children: ReactNode;
  scroll?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const colors = useColors();
  const body = (
    <View style={[{ flex: 1, paddingHorizontal: space.gutter }, style]}>{children}</View>
  );
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={{ paddingBottom: space.xxl }}
          showsVerticalScrollIndicator={false}
        >
          {body}
        </ScrollView>
      ) : (
        body
      )}
    </SafeAreaView>
  );
}

/** §15.2 — "CONTINUE", "UP NEXT", with an optional trailing action. */
export function SectionHeader({
  title,
  action,
  onAction,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  const colors = useColors();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        marginTop: space.section,
        marginBottom: space.sm,
      }}
    >
      <Text variant="overline" color="faint" style={{ textTransform: 'uppercase' }}>
        {title}
      </Text>
      {/*
        A hairline rule running to the action. It costs one View and does the work three
        blank lines of margin were doing badly — sections stop floating and the eye gets
        a horizontal to follow. This is the editorial move that separates "app screen"
        from "list of stuff".
      */}
      <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
      {action ? (
        <Pressable onPress={onAction} hitSlop={12} accessibilityRole="button">
          <Text variant="caption" color="accent">
            {action}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const colors = useColors();
  return (
    <View
      style={[
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          borderWidth: 1,
          borderRadius: radius.md,
          padding: space.sm,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

// ─── Controls ───────────────────────────────────────────────────────────────────

export interface ButtonProps extends Omit<PressableProps, 'style'> {
  title: string;
  /** `primary` is the gold one. §14.1: at most one per screen region. */
  kind?: 'primary' | 'ghost' | 'danger';
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function Button({ title, kind = 'primary', icon, style, ...rest }: ButtonProps) {
  const colors = useColors();
  const bg = kind === 'primary' ? colors.accent : 'transparent';
  const fg = kind === 'primary' ? colors.onAccent : kind === 'danger' ? colors.danger : colors.text;
  const border = kind === 'primary' ? colors.accent : colors.border;

  return (
    <Pressable
      accessibilityRole="button"
      {...rest}
      style={({ pressed }) => [
        {
          minHeight: hit.min,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: space.xs,
          backgroundColor: bg,
          borderColor: border,
          borderWidth: 1,
          borderRadius: radius.md,
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
          opacity: pressed ? 0.75 : 1,
        },
        style,
      ]}
    >
      {icon}
      <RNText
        style={[
          typeScale.title3,
          { color: fg, fontFamily: kind === 'primary' ? undefined : typeScale.title3.fontFamily },
        ]}
      >
        {title}
      </RNText>
    </Pressable>
  );
}

export function Chip({
  label,
  selected = false,
  onPress,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      hitSlop={6}
      style={{
        paddingHorizontal: space.sm,
        paddingVertical: 6,
        borderRadius: radius.full,
        borderWidth: 1,
        backgroundColor: selected ? colors.accentSoft : colors.surface2,
        borderColor: selected ? colors.accentDim : colors.border,
      }}
    >
      <Text variant="caption" color={selected ? 'accent' : 'dim'}>
        {label}
      </Text>
    </Pressable>
  );
}

/** The thin progress line under a resume card, and along the mini player's top edge. */
export function ProgressBar({
  progress,
  height = 3,
  track,
}: {
  progress: number;
  height?: number;
  track?: string;
}) {
  const colors = useColors();
  const clamped = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  return (
    <View
      style={{
        height,
        borderRadius: height / 2,
        backgroundColor: track ?? colors.surface2,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          width: `${clamped * 100}%`,
          height: '100%',
          backgroundColor: colors.accent,
          borderRadius: height / 2,
        }}
      />
    </View>
  );
}

export function Divider() {
  const colors = useColors();
  return <View style={{ height: 1, backgroundColor: colors.border }} />;
}

/** §16 — empty states are instructions, never shrugs. */
export function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <View style={{ paddingVertical: space.xl, gap: space.xs }}>
      <Text variant="title3">{title}</Text>
      <Text variant="body" color="dim">
        {hint}
      </Text>
    </View>
  );
}
