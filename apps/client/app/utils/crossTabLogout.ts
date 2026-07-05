import { isPublicPath } from '@client/app/contexts/ApiContext';
import { buildLoginRedirectUrl } from '@client/app/utils/authRedirect';
import type { LoginErrorCode } from '@client/app/utils/loginErrorMessages';
import { ACCESS_TOKEN_STORAGE_KEY, type ExpiredSessionReason } from '@client/app/hooks/useAccessToken';

// Maps the persisted expiredReason discriminator (useAccessToken store) to the /login
// ?error= code a background tab should surface. A failed mid-session refresh and a
// security-forced logout (e.g. the 3-strike MFA lockout) both clear tokens with
// expired: true, so without this discriminator the background tab can't tell them
// apart and would mislabel a revocation as a plain expiry. Keyed by the store's
// ExpiredSessionReason union so adding a reason without wiring a code fails to compile.
const EXPIRED_REASON_ERROR_CODE: Record<ExpiredSessionReason, LoginErrorCode> = {
  expired: 'session_expired',
  revoked: 'session_revoked',
};

/** The bits of window.location the cross-tab redirect decision needs. Narrowed to a
 *  plain object so the function is pure and unit-testable without a real Location. */
export interface CrossTabLocation {
  pathname: string;
  search: string;
  hash: string;
}

/**
 * Decide where a background tab should navigate when the access-token storage entry
 * changes in another tab (the 'storage' event only fires cross-tab). Returns the URL
 * for window.location.replace, or null when no redirect is warranted (the entry still
 * holds a valid accessToken - e.g. a cross-tab token refresh). Pure so the cross-tab
 * logout branch can be unit-tested without rendering the provider tree.
 */
export function resolveCrossTabRedirect(newValue: string | null, location: CrossTabLocation): string | null {
  // On a public/auth page (login, register, password reset) this tab has no protected
  // content to clear and may hold an in-progress form. Match the in-tab 401 interceptor,
  // which also does nothing on public paths - never yank such a tab to /login on another
  // tab's session change, which would wipe the form.
  if (isPublicPath(location.pathname)) {
    return null;
  }

  // null newValue means the key was removed entirely (localStorage.removeItem) -
  // no payload to read, so treat as a plain logout.
  if (!newValue) {
    return '/login';
  }

  let parsed: { state?: { accessToken?: string | null; expired?: boolean; expiredReason?: string | null } };
  try {
    parsed = JSON.parse(newValue);
  } catch {
    // Malformed JSON - treat as logged out.
    return '/login';
  }

  // A truthy accessToken means the other tab is still authenticated (e.g. it just
  // refreshed the token) - nothing to do in this tab.
  if (parsed?.state?.accessToken) {
    return null;
  }

  // Tokens are cleared (and we're on a protected page - public paths returned above).
  // Only an expired: true payload with a known reason gets the tailored ?error= UX; a
  // voluntary logout (expired: false / unknown reason) gets a plain /login with no toast.
  const reason = parsed?.state?.expired === true ? parsed?.state?.expiredReason : null;
  const errorCode = reason === 'expired' || reason === 'revoked' ? EXPIRED_REASON_ERROR_CODE[reason] : undefined;
  if (errorCode) {
    return buildLoginRedirectUrl(errorCode, location);
  }
  return '/login';
}

/**
 * Storage-event wrapper for the providers.tsx cross-tab listener: ignore events for any
 * other localStorage key, then delegate to resolveCrossTabRedirect. Returns the redirect
 * URL, or null for a no-op. Exported so the listener wiring - including the e.key filter,
 * the easiest thing to get wrong - is unit-tested without rendering the provider tree.
 */
export function resolveStorageEventRedirect(
  event: Pick<StorageEvent, 'key' | 'newValue'>,
  location: CrossTabLocation
): string | null {
  if (event.key !== ACCESS_TOKEN_STORAGE_KEY) {
    return null;
  }
  return resolveCrossTabRedirect(event.newValue, location);
}
