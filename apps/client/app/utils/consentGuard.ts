import { redirect } from '@tanstack/react-router';
import { useUser } from '@client/app/contexts/UserContext';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { buildRedirectTo, shouldRedirectToConsent } from './authRedirect';

/**
 * Consent-redirect guard shared by the app-shell `layoutRoute` and every standalone
 * `rootRoute` child an authenticated user can reach (see router.tsx). Routes an
 * authenticated-but-not-yet-consented account - live `accessToken`, server-confirmed
 * `currentUser` (`isHydrated`), no accepted policy version - to the /accept-policies
 * interstitial, preserving a return path so the flow resumes after acceptance.
 *
 * Defined once so the guard cannot drift between the app shell and the standalone pages
 * (issue #382). It is a `beforeLoad` helper: it THROWS a TanStack `redirect()`, which the
 * router intercepts, so it must be called from inside a route's `beforeLoad` and not wrapped
 * in a try/catch. UX only - the server consent-gate middleware (server/auth/auth.ts) is the
 * real enforcement and fails closed. See shouldRedirectToConsent for the gate rationale
 * (issues #369, #386).
 */
export function enforceConsentRedirect(location: { pathname: string; searchStr: string; hash: string }): void {
  const { currentUser, isHydrated } = useUser.getState();
  const { accessToken } = useAccessToken.getState();
  if (shouldRedirectToConsent({ currentUser, isHydrated, accessToken })) {
    const redirectTo = buildRedirectTo(location.pathname, location.searchStr, location.hash ? `#${location.hash}` : '');
    throw redirect({
      to: '/accept-policies',
      search: redirectTo ? { redirectTo } : undefined,
    });
  }
}
