import { NotAuthenticatedError, SessionRevokedError } from '@bike4mind/client-auth';
import { extractErrorMessage } from '@bike4mind/utils';
import type { AuthTokens } from '../storage/types.js';

/** How long startup waits for an expired access token to be refreshed (ms). */
export const SIGN_IN_REFRESH_TIMEOUT_MS = 10_000;

export type SavedSignIn =
  | { status: 'signed-in'; tokens: AuthTokens }
  | { status: 'signed-out' }
  /** The server rejected the refresh token; the refresh path cleared it unless another process had replaced it. */
  | { status: 'expired' }
  /** The refresh could not complete (network, timeout, 5xx); the tokens are kept for the next run. */
  | { status: 'unchecked'; reason: string };

/**
 * The saved sign-in at startup. The access token lasts minutes and the refresh token weeks, so an expired
 * access token is refreshed (through `refresh`, the shared refresh path) before the run is called signed out.
 */
export async function checkSavedSignIn(
  store: { getAuthTokens(): Promise<AuthTokens | null> },
  refresh: (rejectedAccessToken: string) => Promise<AuthTokens>,
  timeoutMs = SIGN_IN_REFRESH_TIMEOUT_MS
): Promise<SavedSignIn> {
  const tokens = await store.getAuthTokens();
  if (!tokens) return { status: 'signed-out' };
  if (new Date(tokens.expiresAt).getTime() > Date.now()) return { status: 'signed-in', tokens };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const refreshed = await Promise.race([
      Promise.resolve().then(() => refresh(tokens.accessToken)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs / 1000}s`)), timeoutMs);
      }),
    ]);
    return { status: 'signed-in', tokens: refreshed };
  } catch (error) {
    if (error instanceof SessionRevokedError) return { status: 'expired' };
    if (error instanceof NotAuthenticatedError) return { status: 'signed-out' };
    return { status: 'unchecked', reason: extractErrorMessage(error) };
  } finally {
    clearTimeout(timer);
  }
}
