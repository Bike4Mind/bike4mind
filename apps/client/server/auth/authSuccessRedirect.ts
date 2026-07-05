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
