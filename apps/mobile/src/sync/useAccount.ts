/**
 * Account state for the UI.
 *
 * Deliberately thin: it exposes who is signed in and the three actions, and nothing
 * about Firebase. Screens import from here, never from `@feast/sync` directly, so the
 * error strings stay in one place.
 */
import { useCallback, useEffect, useState } from 'react';
import { SyncError } from '@feast/sync';
import { getSyncBackend } from './backend';

export type AccountState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; userId: string }
  | { status: 'unavailable' };

export function useAccount(): AccountState {
  const [state, setState] = useState<AccountState>(() =>
    getSyncBackend() ? { status: 'loading' } : { status: 'unavailable' },
  );

  useEffect(() => {
    const backend = getSyncBackend();
    if (!backend) return;
    // Fires once on restore-from-disk too, which is what moves us off 'loading'.
    return backend.onAuthChange((userId) =>
      setState(userId ? { status: 'signed-in', userId } : { status: 'signed-out' }),
    );
  }, []);

  return state;
}

export interface AccountActions {
  signUp(email: string, password: string): Promise<void>;
  signIn(email: string, password: string): Promise<void>;
  resetPassword(email: string): Promise<void>;
  signOut(): Promise<void>;
}

export function useAccountActions(): AccountActions & { error: string | null; busy: boolean } {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(humanize(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    error,
    busy,
    signUp: (email, password) =>
      run(() => required().signUp(email, password)).then(() => undefined),
    signIn: (email, password) =>
      run(() => required().signIn(email, password)).then(() => undefined),
    resetPassword: (email) => run(() => required().resetPassword(email)).then(() => undefined),
    signOut: () => run(() => required().signOut()).then(() => undefined),
  };
}

function required() {
  const backend = getSyncBackend();
  if (!backend) throw new SyncError('unknown', 'Sync is not configured in this build.');
  return backend;
}

/**
 * §16: "Errors are honest and actionable." Firebase's raw codes are neither — a user
 * who mistypes a password should not be shown `auth/invalid-credential`.
 */
function humanize(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);

  if (raw.includes('invalid-credential') || raw.includes('wrong-password'))
    return "That email and password don't match an account.";
  if (raw.includes('email-already-in-use'))
    return 'There is already an account with that email — try signing in instead.';
  if (raw.includes('invalid-email')) return "That doesn't look like an email address.";
  if (raw.includes('weak-password')) return 'Pick a password of at least 6 characters.';
  if (raw.includes('too-many-requests'))
    return 'Too many attempts. Wait a minute and try again.';
  if (raw.includes('network')) return 'No connection. Your library still works offline.';
  if (raw.includes('operation-not-allowed'))
    return 'Email sign-in is not enabled for this project yet.';
  return raw;
}
