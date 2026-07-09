/**
 * Helpers for the post-login `redirectTo` flow.
 *
 * `redirectTo` carries the path the user was trying to reach before being
 * bounced to /login. It must be a same-origin, relative path - never a full
 * URL - to prevent open-redirect vulnerabilities.
 */

import type { LoginErrorCode } from './loginErrorMessages';

// Matches ASCII control characters (NUL..US, DEL) plus Unicode line
// terminators (NEL, Line Separator, Paragraph Separator). Reject these
// in `redirectTo` values as defense-in-depth against log/header injection
// if the raw URL flows into telemetry sinks - some log sinks and JSON
// parsers treat U+0085/U+2028/U+2029 as line breaks.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f\u0085\u2028\u2029]/;

/**
 * Validates and normalizes a `redirectTo` value.
 *
 * Returns the value unchanged if it is a safe same-origin path (starts with a
 * single `/` followed by a non-slash, non-backslash char). Returns `undefined`
 * for anything else - including protocol-relative URLs (`//evil.com`),
 * backslash tricks (`/\evil.com`), absolute URLs, control-char injection,
 * and `/login` itself (which would cause a redirect loop).
 */
export function sanitizeRedirectTo(value: unknown): string | undefined {
  // Need at least one char after the leading slash (e.g. `/x`).
  if (typeof value !== 'string' || value.length < 2) return undefined;
  if (value[0] !== '/') return undefined;
  // Block protocol-relative (`//host`) and backslash-host (`/\host`) which
  // some browsers normalize to cross-origin navigations.
  if (value[1] === '/' || value[1] === '\\') return undefined;
  if (CONTROL_CHARS.test(value)) return undefined;
  // Avoid redirecting back to /login itself.
  const [pathOnly] = value.split(/[?#]/);
  if (pathOnly === '/login') return undefined;
  return value;
}

/**
 * Builds the `redirectTo` value to pass to /login from the location the user
 * was bounced from. Returns `undefined` if the location is not worth
 * preserving (e.g. unauthenticated user landing on `/`).
 */
export function buildRedirectTo(pathname: string, search = '', hash = ''): string | undefined {
  if (!pathname || pathname === '/') return undefined;
  return sanitizeRedirectTo(pathname + (search || '') + (hash || ''));
}

/**
 * Builds the full `/login` URL used to force re-authentication with a reason:
 * `/login?error=<errorCode>`, plus a sanitized `redirectTo` when the current
 * location is worth preserving. Shared by the in-tab 401 interceptor
 * (ApiContext) and the cross-tab logout listener (crossTabLogout) so the two
 * paths construct the URL identically and can't drift.
 */
export function buildLoginRedirectUrl(
  errorCode: LoginErrorCode,
  location: { pathname: string; search?: string; hash?: string }
): string {
  const redirectTo = buildRedirectTo(location.pathname, location.search, location.hash);
  const params = new URLSearchParams({ error: errorCode });
  if (redirectTo) params.set('redirectTo', redirectTo);
  return `/login?${params.toString()}`;
}

/**
 * Navigates to a sanitized `redirectTo` path using the router history, which
 * accepts a raw URL string (including a query string). Falls back to `/new`
 * if the value is unsafe or missing.
 *
 * Tanstack Router's `navigate({ to })` treats `to` as a pathname only - a
 * value like `"/admin?foo=bar"` is URL-encoded into the path, losing the
 * query. Going through history avoids that.
 *
 * Pass `replace: true` when bouncing an already-authenticated user away from
 * /login so the login page does not pollute the back-button history. For
 * post-login navigations (after submitting a password or MFA code), leave
 * `replace` false - those should push so Back returns to the prior step.
 *
 * The `history` param uses a structural type rather than `RouterHistory` from
 * `@tanstack/history` so this util stays mockable in unit tests without
 * dragging in TSR's full router surface. Don't tighten the type - the
 * looseness is intentional.
 */
export function applyRedirect(
  history: { push: (path: string) => void; replace: (path: string) => void },
  rawRedirectTo: unknown,
  fallback = '/new',
  replace = false
): void {
  const target = sanitizeRedirectTo(rawRedirectTo) ?? fallback;
  if (replace) {
    history.replace(target);
  } else {
    history.push(target);
  }
}

/**
 * Decides whether the layout `beforeLoad` guard should bounce an authenticated
 * user to the /accept-policies interstitial.
 *
 * Redirect ONLY when the user has been confirmed by the server this page load
 * (`isHydrated` - flipped true the first time /api/identify, refreshUser, or a
 * WebSocket push writes a non-null user) AND still lacks an accepted policy
 * version. Gating on `isHydrated` is what fixes the post-deploy edge case: a
 * session that was already logged in when the consent feature shipped rehydrates
 * from a persisted `user-context` stub that predates `aupAcceptedVersion`, so the
 * field reads as missing. Before identify refetches (which honors a 5-min
 * `staleTime` when the stub is seeded as react-query `initialData`), that stub
 * would otherwise trip a spurious interstitial flash on hard reload. Deferring
 * until `isHydrated` lets the server-authoritative (grandfathered) value land
 * first. A genuinely un-consented account is still gated: after login, identify
 * sets the user (isHydrated true) with no `aupAcceptedVersion`, so the guard
 * fires on the next protected navigation. This client redirect is UX only - the
 * server consent-gate middleware is the real enforcement and fails closed.
 */
export function shouldRedirectToConsent(params: {
  currentUser: { aupAcceptedVersion?: unknown } | null;
  isHydrated: boolean;
}): boolean {
  return !!params.currentUser && params.isHydrated && !params.currentUser.aupAcceptedVersion;
}

/**
 * Merges a `redirectTo` value onto a relative provider auth URL so social/SSO
 * login can round-trip it through the IdP `state`/`RelayState` param instead of
 * stashing it (the full-page navigation to the provider drops the SPA's in-URL
 * `?redirectTo=`; the server re-attaches it to `/auth/success` after callback).
 *
 * Returns the URL unchanged when `redirectTo` is empty. The target may already
 * carry a query (e.g. `/api/auth/okta?idp=...`), so the value is merged via
 * `URLSearchParams`, which percent-encodes it - so an embedded query string
 * (e.g. the OAuth authorize URL `/oauth/authorize?client_id=...&redirect_uri=...`)
 * survives intact. The result is kept relative (path + query). The dummy base
 * only enables relative-URL parsing and never appears in the output.
 *
 * Validation lives at the post-login chokepoint (`applyRedirect` ->
 * `sanitizeRedirectTo`), so the value is passed through as-is here.
 */
export function appendRedirectTo(targetUrl: string, redirectTo: string | null | undefined): string {
  if (!redirectTo) return targetUrl;
  const url = new URL(targetUrl, 'http://localhost');
  url.searchParams.set('redirectTo', redirectTo);
  return `${url.pathname}${url.search}`;
}
