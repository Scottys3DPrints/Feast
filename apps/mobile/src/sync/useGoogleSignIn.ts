/**
 * Google sign-in — `expo-auth-session` for the OAuth dance, Firebase for the session.
 *
 * The split matters: this hook owns the browser redirect and produces an ID token; the
 * sync package exchanges that token for a Firebase session and knows nothing about
 * platforms or redirects (see `signInWithGoogleIdToken`).
 *
 * ⚠️ TWO CLIENT IDS, AND THEY ARE NOT INTERCHANGEABLE.
 *
 *  • `androidClientId` identifies the app during the OAuth flow. Google verifies it
 *    against the app's SIGNING CERTIFICATE, which is why the SHA-1 of feast-release.jks
 *    had to be registered in Firebase. Without it the flow dies with `DEVELOPER_ERROR`,
 *    which says nothing about the cause.
 *  • `webClientId` is the audience the ID TOKEN is minted for, and it is the one
 *    Firebase validates against. Omitting it yields a token Firebase rejects even
 *    though Google issued it happily.
 *
 * Both come from the Firebase project's google-services config and are not secrets —
 * they ship in every Android app that uses Google sign-in.
 */
import { useCallback, useEffect, useState } from 'react';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import Constants from 'expo-constants';
import { getSyncBackend } from './backend';

// Required so the auth redirect can close the in-app browser and hand control back.
WebBrowser.maybeCompleteAuthSession();

function clientIds() {
  const extra = Constants.expoConfig?.extra as Record<string, string | undefined> | undefined;
  return {
    androidClientId: extra?.['googleAndroidClientId'] ?? '',
    webClientId: extra?.['googleWebClientId'] ?? '',
  };
}

export function useGoogleSignIn() {
  const { androidClientId, webClientId } = clientIds();
  const configured = Boolean(androidClientId && webClientId);

  const [request, response, promptAsync] = Google.useIdTokenAuthRequest({
    androidClientId,
    clientId: webClientId,
  });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!response) return;

    if (response.type === 'error') {
      setError('Google sign-in failed. Try again, or use email instead.');
      setBusy(false);
      return;
    }
    if (response.type === 'dismiss' || response.type === 'cancel') {
      setBusy(false);
      return;
    }
    if (response.type !== 'success') return;

    const idToken = response.params?.['id_token'];
    if (!idToken) {
      setError('Google did not return an identity token.');
      setBusy(false);
      return;
    }

    const backend = getSyncBackend();
    if (!backend) {
      setError('Sync is not configured in this build.');
      setBusy(false);
      return;
    }

    backend
      .signInWithGoogleIdToken(idToken)
      .catch(() => setError('Could not complete sign-in. Try again.'))
      .finally(() => setBusy(false));
  }, [response]);

  const signIn = useCallback(() => {
    if (!configured) {
      setError('Google sign-in is not configured in this build.');
      return;
    }
    setError(null);
    setBusy(true);
    void promptAsync().catch(() => setBusy(false));
  }, [configured, promptAsync]);

  return { signIn, busy, error, available: configured && Boolean(request) };
}
