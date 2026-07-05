/**
 * Auth Parameters Parser Utility
 *
 * Parses OAuth tokens from URL - supports both query params (legacy) and hash fragments (secure)
 *
 * Hash fragments are preferred because they:
 * - Are not sent to servers in Referer headers
 * - Are not logged in server access logs
 * - Provide better security for OAuth token transport
 */

export interface AuthParams {
  token?: string;
  refreshToken?: string;
  userId?: string;
  error?: string;
  /** True only when the OAuth callback just created a brand-new account. */
  isNewUser?: boolean;
  /** OAuth strategy that created the account (e.g. "google"); set with isNewUser. */
  signupMethod?: string;
}

/**
 * Parse auth parameters from a hash fragment string.
 * Pure function for testability.
 *
 * @param hash - The hash fragment (with or without leading #)
 * @returns Parsed auth parameters or null if incomplete
 */
export function parseHashParams(hash: string): AuthParams | null {
  if (!hash) {
    return null;
  }

  // Remove leading # if present
  const hashContent = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!hashContent) {
    return null;
  }

  const hashParams = new URLSearchParams(hashContent);
  const token = hashParams.get('token');
  const refreshToken = hashParams.get('refreshToken');
  const userId = hashParams.get('userId');
  const error = hashParams.get('error');

  // Only return hash params if we have complete token data
  if (token && refreshToken && userId) {
    return {
      token,
      refreshToken,
      userId,
      error: error || undefined,
      isNewUser: hashParams.get('isNewUser') === '1' || undefined,
      signupMethod: hashParams.get('signupMethod') || undefined,
    };
  }

  // If we only have an error in the hash, return that
  if (error) {
    return { error };
  }

  return null;
}

/**
 * Parse auth parameters from query search params.
 *
 * @param search - Search params object (from router)
 * @returns Parsed auth parameters
 */
export function parseQueryParams(search: Record<string, unknown>): AuthParams {
  return {
    token: typeof search.token === 'string' ? search.token : undefined,
    refreshToken: typeof search.refreshToken === 'string' ? search.refreshToken : undefined,
    userId: typeof search.userId === 'string' ? search.userId : undefined,
    error: typeof search.error === 'string' ? search.error : undefined,
  };
}

/**
 * Parse auth parameters from URL, preferring hash fragments over query params.
 * Also clears the hash fragment to minimize token exposure time.
 *
 * @param search - Search params from router
 * @param windowRef - Window reference (for SSR safety and testability)
 * @returns Parsed auth parameters
 */
export function parseAuthParams(search: Record<string, unknown>, windowRef?: Window): AuthParams {
  // Use provided window or global window (SSR-safe)
  const win = windowRef ?? (typeof window !== 'undefined' ? window : undefined);

  // First, try to read from URL hash fragment (more secure, preferred)
  if (win?.location?.hash) {
    // Immediately capture and clear the hash to minimize token exposure time
    const hash = win.location.hash;
    win.history?.replaceState(null, '', win.location.pathname + win.location.search);

    const hashResult = parseHashParams(hash);
    if (hashResult) {
      return hashResult;
    }
  }

  // Fall back to query params for backwards compatibility
  return parseQueryParams(search);
}
