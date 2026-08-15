import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Text } from '../../src/ui/primitives';
import { useAccountActions } from '../../src/sync/useAccount';
import { useColors } from '../../src/ui/theme';
import { radius, space, type as typeScale } from '../../src/ui/tokens';

/**
 * Account screen — sign in or create one.
 *
 * The account is what makes a list you build on this phone show up on the next one, so
 * the copy leads with that rather than with "sign in to continue". It is also skippable:
 * §3.1 makes SQLite the source of truth for reads, so the library works fully without an
 * account — you just lose sync. Forcing a login on a personal offline-first app would be
 * theatre.
 */
export default function SignInScreen() {
  const colors = useColors();
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const { signIn, signUp, resetPassword, error, busy } = useAccountActions();

  const submit = () => {
    setNotice(null);
    const action = mode === 'sign-in' ? signIn : signUp;
    void action(email, password).catch(() => {
      /* surfaced through `error` */
    });
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={{ padding: space.lg, paddingTop: space.xxl }}
          keyboardShouldPersistTaps="handled"
        >
          <Text variant="display">
            {mode === 'sign-in' ? 'Welcome back' : 'Create your account'}
          </Text>
          <Text variant="body" color="dim" style={{ marginTop: space.xs }}>
            Your collections, ratings, bookmarks and listening position follow your
            account — so the lists you build here show up on every device you sign in on.
          </Text>

          <Field
            label="Email"
            value={email}
            onChange={setEmail}
            placeholder="you@example.com"
            keyboardType="email-address"
            autoComplete="email"
          />
          <Field
            label="Password"
            value={password}
            onChange={setPassword}
            placeholder={mode === 'sign-up' ? 'At least 6 characters' : ''}
            secure
            autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
          />

          {error ? (
            <Text variant="body" style={{ color: colors.danger, marginTop: space.sm }}>
              {error}
            </Text>
          ) : null}
          {notice ? (
            <Text variant="body" color="accent" style={{ marginTop: space.sm }}>
              {notice}
            </Text>
          ) : null}

          <Button
            title={busy ? 'Working…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
            onPress={submit}
            disabled={busy || !email || !password}
            style={{ marginTop: space.md, opacity: busy || !email || !password ? 0.5 : 1 }}
          />

          <Pressable
            onPress={() => {
              setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in');
              setNotice(null);
            }}
            style={{ marginTop: space.md, alignItems: 'center' }}
            accessibilityRole="button"
          >
            <Text variant="label" color="accent">
              {mode === 'sign-in'
                ? 'No account yet? Create one'
                : 'Already have an account? Sign in'}
            </Text>
          </Pressable>

          {mode === 'sign-in' ? (
            <Pressable
              onPress={() => {
                if (!email) return;
                void resetPassword(email)
                  .then(() => setNotice('If that address has an account, a reset email is on its way.'))
                  .catch(() => undefined);
              }}
              style={{ marginTop: space.sm, alignItems: 'center' }}
              accessibilityRole="button"
            >
              <Text variant="caption" color="faint">
                Forgot your password?
              </Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  secure,
  keyboardType,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  secure?: boolean;
  keyboardType?: 'email-address';
  autoComplete?: 'email' | 'new-password' | 'current-password';
}) {
  const colors = useColors();
  return (
    <View style={{ marginTop: space.md }}>
      <Text variant="overline" color="faint" style={{ textTransform: 'uppercase' }}>
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        secureTextEntry={secure}
        keyboardType={keyboardType}
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect={false}
        style={[
          typeScale.body,
          {
            color: colors.text,
            backgroundColor: colors.surface,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: radius.md,
            paddingHorizontal: space.sm,
            paddingVertical: space.sm,
            marginTop: 6,
          },
        ]}
      />
    </View>
  );
}
