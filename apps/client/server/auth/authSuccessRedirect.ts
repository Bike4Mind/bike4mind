/**
 * Builds the `?redirectTo=...` query segment appended to the `/auth/success` URL
 * after a social/SSO callback. Returns `''` when there is no redirect target.
 *
 * The post-login path is round-tripped through the IdP `state`/`RelayState`
 * param and re-attached here so `/auth/success` can resume it (validated
 * client-side by `sanitizeRedirectTo` before navigation). It is percent-encoded
 * so an embedded query string - e.g. the OAuth authorize URL
 * `/oauth/authorize?client_id=...&redirect_uri=...` - survives as a single opaque
 * value and never bleeds into the `#token=...` fragment that follows it in the
 * success URL.
 */
export function authSuccessRedirectQuery(redirectTo: string | null | undefined): string {
  return redirectTo ? `?redirectTo=${encodeURIComponent(redirectTo)}` : '';
}

/**
 * Fragment handing an SSO sign-in that still owes a second factor to `/auth/success`, which
 * opens the MFA challenge (or enrollment) with the mfaPending token instead of a session.
 * Deliberately not `token=`: a client that predates this must never mistake it for a session.
 * Must stay in sync with parseHashParams in app/utils/authParams.ts.
 */
export function mfaHandoffFragment({
  mfaToken,
  userId,
  mode,
  passkeyAvailable,
}: {
  mfaToken: string;
  userId: string;
  mode: 'verify' | 'setup';
  passkeyAvailable: boolean;
}): string {
  return `#mfaToken=${mfaToken}&userId=${userId}&mfa=${mode}${passkeyAvailable ? '&passkey=1' : ''}`;
}
