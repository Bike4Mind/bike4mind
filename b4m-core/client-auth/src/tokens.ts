/**
 * Tokens issued by the device-authorization flow, in the shape a client persists them.
 * `expiresAt` is an absolute ISO 8601 timestamp rather than the grant's relative
 * `expires_in` so a store can be read back cold without knowing when it was written.
 */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  userId: string;
}

/**
 * Persistence port for {@link AuthTokens}. This package owns no storage policy: the CLI
 * backs this with its on-disk config, a desktop app with the OS keychain. Every method is
 * async because a keychain read is.
 */
export interface TokenStore {
  getAuthTokens(): Promise<AuthTokens | null>;
  setAuthTokens(tokens: AuthTokens): Promise<void>;
  clearAuthTokens(): Promise<void>;
  isAuthenticated(): Promise<boolean>;
}

/**
 * Logging port. Matches the CLI logger's shape so it can be passed straight in; a host with
 * no logging of its own can supply no-ops.
 */
export interface AuthLogger {
  debug(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
}

/**
 * Normalize an API URL for use as a per-environment token cache key.
 *
 * Without normalization, `https://x.com` and `https://x.com/` (or `HTTPS://X.com`) would
 * create separate cache entries, defeating token reuse when the user switches back to an
 * environment they already authenticated against.
 */
export function normalizeEnvKey(url: string): string {
  return url.toLowerCase().replace(/\/+$/, '');
}

/**
 * Treat a token as "authenticated" only when it has an `expiresAt` in the future. A caller
 * that auto-refreshes on startup still wants this, so a UI does not claim a saved login is
 * being reused when it is actually about to trigger a re-auth.
 */
export function isAuthTokenValid(auth: AuthTokens | undefined): boolean {
  if (!auth) return false;
  return new Date(auth.expiresAt) > new Date();
}

/** The active token plus the per-environment cache it is swapped in and out of. */
export interface EnvAuthState {
  auth?: AuthTokens;
  authByEnv?: Record<string, AuthTokens>;
}

export interface EnvAuthSwap extends EnvAuthState {
  authByEnv: Record<string, AuthTokens>;
  /** False when both URLs normalize to the same key; the state is then returned untouched. */
  changed: boolean;
}

/**
 * Stash the active token under the environment being left and restore the one cached for the
 * environment being entered, so flipping between a hosted and a self-hosted instance does not
 * force a re-login each time. Pure: the caller decides how to persist the result.
 *
 * A missing entry for the target environment yields `auth: undefined` - the caller prompts to
 * log in.
 */
export function swapActiveEnvAuth(state: EnvAuthState, prevUrl: string, nextUrl: string): EnvAuthSwap {
  const prevKey = normalizeEnvKey(prevUrl);
  const nextKey = normalizeEnvKey(nextUrl);

  if (prevKey === nextKey) {
    return { auth: state.auth, authByEnv: state.authByEnv ?? {}, changed: false };
  }

  const authByEnv: Record<string, AuthTokens> = { ...(state.authByEnv || {}) };
  if (state.auth) {
    authByEnv[prevKey] = state.auth;
  } else {
    delete authByEnv[prevKey];
  }

  return { auth: authByEnv[nextKey], authByEnv, changed: true };
}
