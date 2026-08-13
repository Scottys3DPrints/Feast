import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import type { TokenProvider } from '@feast/storage';

/**
 * Microsoft sign-in — SPEC §4.4 (Auth), §15.1 (Onboarding).
 *
 * OAuth2 auth-code + PKCE (S256) via the system browser. No client secret — this is a
 * public client. There is no official MSAL for React Native, so `expo-auth-session`
 * plus `expo-secure-store` is the whole implementation.
 *
 * FOUR THINGS THAT WILL BITE IF CHANGED:
 *
 *   1. The tenant segment is `consumers`, not `common` or `organizations`. This is a
 *      personal OneDrive.
 *   2. Scopes are `Files.ReadWrite offline_access openid profile` +
 *      `Files.ReadWrite.AppFolder`. ⚠️ `Files.Read.All` / `Files.ReadWrite.All` are
 *      REJECTED for consumer accounts — `Files.ReadWrite` already covers the whole
 *      personal drive.
 *   3. ⚠️ The redirect URI must be registered in Entra under "Mobile and desktop
 *      applications", NOT "Single-page application". An spa-typed redirect caps
 *      refresh tokens at 24 HOURS, which turns a sign-in-once app into a sign-in-daily
 *      one. This is invisible until a day after you ship.
 *   4. Refresh tokens are 90-day rolling. Refresh at least once per 90 days and the
 *      user never signs in again.
 */

const TENANT = 'consumers';
export const MS_DISCOVERY: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
  tokenEndpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
  revocationEndpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout`,
};

export const MS_SCOPES = [
  'Files.ReadWrite',
  'Files.ReadWrite.AppFolder',
  'offline_access',
  'openid',
  'profile',
];

const KEY_REFRESH = 'feast.ms.refreshToken';
const KEY_ACCESS = 'feast.ms.accessToken';
const KEY_EXPIRY = 'feast.ms.accessTokenExpiry';

export function getClientId(): string {
  const id =
    (Constants.expoConfig?.extra as { msClientId?: string } | undefined)?.msClientId ??
    process.env.EXPO_PUBLIC_MS_CLIENT_ID ??
    '';
  return id;
}

export function getRedirectUri(): string {
  // `feast://auth` — register this exact string in Entra under
  // Authentication → Add a platform → Mobile and desktop applications → Custom URI.
  return AuthSession.makeRedirectUri({ scheme: 'feast', path: 'auth' });
}

export interface StoredTokens {
  refreshToken: string;
  accessToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
}

async function readTokens(): Promise<StoredTokens | null> {
  const refreshToken = await SecureStore.getItemAsync(KEY_REFRESH);
  if (!refreshToken) return null;
  const accessToken = (await SecureStore.getItemAsync(KEY_ACCESS)) ?? undefined;
  const expiryRaw = await SecureStore.getItemAsync(KEY_EXPIRY);
  const expiresAt = expiryRaw ? Number(expiryRaw) : undefined;
  return { refreshToken, ...(accessToken ? { accessToken } : {}), ...(expiresAt ? { expiresAt } : {}) };
}

async function writeTokens(t: StoredTokens): Promise<void> {
  // Written under separate keys rather than one JSON blob: SecureStore warns above
  // ~2 KB per value on Android, and a Microsoft access token alone can approach that.
  await SecureStore.setItemAsync(KEY_REFRESH, t.refreshToken);
  if (t.accessToken) await SecureStore.setItemAsync(KEY_ACCESS, t.accessToken);
  if (t.expiresAt) await SecureStore.setItemAsync(KEY_EXPIRY, String(t.expiresAt));
}

export async function clearTokens(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(KEY_REFRESH),
    SecureStore.deleteItemAsync(KEY_ACCESS),
    SecureStore.deleteItemAsync(KEY_EXPIRY),
  ]);
}

export async function isSignedIn(): Promise<boolean> {
  return (await SecureStore.getItemAsync(KEY_REFRESH)) !== null;
}

/** Thrown when the refresh token is gone or revoked and only a UI prompt can fix it. */
export class ReauthRequiredError extends Error {
  constructor(message = 'Sign in to Microsoft again to keep streaming your library.') {
    super(message);
    this.name = 'ReauthRequiredError';
  }
}

/**
 * Interactive sign-in. Opens the system browser, runs PKCE, persists the refresh token.
 * Returns false if the user dismissed the browser.
 */
export async function signIn(): Promise<boolean> {
  const clientId = getClientId();
  if (!clientId) {
    throw new Error(
      'No Microsoft client id. Set EXPO_PUBLIC_MS_CLIENT_ID — see README "Microsoft app registration".',
    );
  }

  const request = new AuthSession.AuthRequest({
    clientId,
    scopes: MS_SCOPES,
    redirectUri: getRedirectUri(),
    responseType: AuthSession.ResponseType.Code,
    usePKCE: true, // S256; expo-auth-session generates verifier + challenge
  });

  const result = await request.promptAsync(MS_DISCOVERY);
  if (result.type !== 'success' || !result.params['code']) return false;

  const token = await AuthSession.exchangeCodeAsync(
    {
      clientId,
      code: result.params['code'],
      redirectUri: getRedirectUri(),
      extraParams: request.codeVerifier ? { code_verifier: request.codeVerifier } : {},
    },
    MS_DISCOVERY,
  );

  if (!token.refreshToken) {
    // No refresh token means `offline_access` was not granted, which means the app
    // would silently stop working in ~75 minutes. Fail loudly now instead.
    throw new Error('Microsoft did not return a refresh token — is `offline_access` in the scopes?');
  }

  await writeTokens({
    refreshToken: token.refreshToken,
    accessToken: token.accessToken,
    expiresAt: expiryFrom(token),
  });
  return true;
}

function expiryFrom(token: AuthSession.TokenResponse): number {
  // Access tokens last 60–90 min, randomized (~75 avg). Treating them as expired 5
  // minutes early costs one extra refresh a day and removes a whole class of
  // "expired one second after we checked" races.
  const seconds = token.expiresIn ?? 3600;
  return Date.now() + Math.max(0, seconds - 300) * 1000;
}

/**
 * The `TokenProvider` handed to `OneDriveProvider`.
 *
 * Single-flight: N concurrent Graph calls that all find a stale token must produce
 * ONE refresh, not N. Microsoft rotates the refresh token on every use, so parallel
 * refreshes race to invalidate each other's result and can end with a signed-out user.
 */
export class MsTokenProvider implements TokenProvider {
  #cached: { token: string; expiresAt: number } | null = null;
  #inFlight: Promise<string> | null = null;

  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.#cached && this.#cached.expiresAt > now) return this.#cached.token;
    if (this.#inFlight) return this.#inFlight;

    this.#inFlight = this.#refresh().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  /** Called by GraphClient on a 401 so the next call re-refreshes rather than reusing. */
  invalidate(): void {
    this.#cached = null;
  }

  async #refresh(): Promise<string> {
    const stored = await readTokens();
    if (!stored) throw new ReauthRequiredError();

    if (stored.accessToken && stored.expiresAt && stored.expiresAt > Date.now()) {
      this.#cached = { token: stored.accessToken, expiresAt: stored.expiresAt };
      return stored.accessToken;
    }

    const clientId = getClientId();
    let token: AuthSession.TokenResponse;
    try {
      token = await AuthSession.refreshAsync(
        { clientId, scopes: MS_SCOPES, refreshToken: stored.refreshToken },
        MS_DISCOVERY,
      );
    } catch (cause) {
      // `invalid_grant` means revoked, or 90 days elapsed with no use. Only a UI
      // prompt fixes it, so clear the dead token rather than retrying forever.
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.includes('invalid_grant')) {
        await clearTokens();
        throw new ReauthRequiredError();
      }
      throw cause;
    }

    if (!token.accessToken) throw new ReauthRequiredError();

    const expiresAt = expiryFrom(token);
    await writeTokens({
      // Microsoft rotates refresh tokens; keep the new one when offered.
      refreshToken: token.refreshToken ?? stored.refreshToken,
      accessToken: token.accessToken,
      expiresAt,
    });
    this.#cached = { token: token.accessToken, expiresAt };
    return token.accessToken;
  }
}
