import { BadRequestError } from '@server/utils/errors';

// Kept apart from common.ts, which reads Config at import: test suites that mock common.ts reuse
// these real predicates (vi.importActual) instead of hand-copying them.

/**
 * Whether a token-resolution failure needs the user to reconnect, as opposed to a blip (Google 5xx,
 * network, Mongo) that the next poll can retry. Only the former may mark a connection
 * `credential_error`: nothing but a manual reconnect clears that state, and the poll skips it.
 */
export function isTerminalDriveGrantError(e: unknown): boolean {
  // getValidUserDriveAccessToken's expected states (unlinked, unreadable, revoked) are all reconnects.
  return e instanceof BadRequestError || isInvalidGrantError(e);
}

/** A revoked/expired Google grant: only a fresh consent fixes it. */
export function isInvalidGrantError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  // google-auth-library surfaces a revoked/expired grant as a GaxiosError whose body is the OAuth error.
  const response: unknown = 'response' in e ? e.response : undefined;
  const data: unknown = response && typeof response === 'object' && 'data' in response ? response.data : undefined;
  const oauthError: unknown = data && typeof data === 'object' && 'error' in data ? data.error : undefined;
  return oauthError === 'invalid_grant' || e.message === 'invalid_grant';
}
