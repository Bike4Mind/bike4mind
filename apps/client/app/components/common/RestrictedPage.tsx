import { useUser } from '@client/app/contexts/UserContext';
import { useEntitlementGate, EntitlementGateState } from '@client/app/hooks/useEntitlementGate';
import { applyRedirect, buildRedirectTo } from '@client/app/utils/authRedirect';
import { useRouter, useNavigate } from '@tanstack/react-router';
import { FC, PropsWithChildren, useEffect } from 'react';

interface RestrictedPageProps {
  requireAdmin?: boolean;
  /** Grants when the user carries the tag (admins/developers bypass). */
  requireFeatureTag?: string;
  /**
   * Grants when the user holds the server-resolved entitlement key
   * (subscription- or tag-derived - see `useEntitlements`). Admins/developers
   * bypass. When BOTH this and `requireFeatureTag` are set, satisfying either
   * grants (OR).
   */
  requireEntitlement?: string;
  /**
   * Where denied users are sent instead of the default `/new` eject. Applies
   * to ALL denial redirects - `requireAdmin`, `requireFeatureTag`, and
   * `requireEntitlement` alike. Must be a same-origin path (unsafe values
   * fall back to `/new` via `applyRedirect`) pointing at an UNGATED route -
   * a gated fallback whose gate also denies would ping-pong between the two
   * pages. An upgrade/marketing page qualifies.
   */
  fallbackPath?: string;
}

const RestrictedPage: FC<PropsWithChildren<RestrictedPageProps>> = ({
  children,
  requireAdmin = false,
  requireFeatureTag,
  requireEntitlement,
  fallbackPath = '/new',
}) => {
  const { currentUser } = useUser();
  const router = useRouter();
  const navigate = useNavigate();
  const pathname = router.state.location.pathname;

  // Membership decision (bypass, normalized-key compare, fail-open on query
  // error) lives in the shared hook so nav-visibility checks match this gate.
  const { state: entitlementState, bypass } = useEntitlementGate(requireEntitlement);

  const tagState: EntitlementGateState | undefined = !requireFeatureTag
    ? undefined
    : bypass || (currentUser?.tags ?? []).some(tag => tag.toLowerCase() === requireFeatureTag.toLowerCase())
      ? 'satisfied'
      : 'denied';

  // No requirements set = login-only mode. With requirements, satisfying any
  // one grants (OR); a pending entitlement query holds (render null, no
  // redirect); only an all-requirements-denied state ejects.
  const requirementStates = [tagState, entitlementState].filter(
    (state): state is EntitlementGateState => state !== undefined
  );
  const accessState: EntitlementGateState =
    requirementStates.length === 0 || requirementStates.includes('satisfied')
      ? 'satisfied'
      : requirementStates.includes('pending')
        ? 'pending'
        : 'denied';

  // Handle redirects in useEffect to avoid setState during render
  useEffect(() => {
    if (!currentUser && pathname !== '/login') {
      const redirectTo = buildRedirectTo(
        pathname,
        router.state.location.searchStr,
        router.state.location.hash ? `#${router.state.location.hash}` : ''
      );
      navigate({ to: '/login', search: redirectTo ? { redirectTo } : undefined });
      return;
    }

    if (currentUser && pathname === '/login') {
      const redirectTo = (router.state.location.search as { redirectTo?: unknown })?.redirectTo;
      // `replace` so /login does not remain in history.
      applyRedirect(router.history, redirectTo, '/new', true);
      return;
    }

    if (currentUser && requireAdmin && !currentUser.isAdmin) {
      applyRedirect(router.history, fallbackPath, '/new');
      return;
    }

    // Only a definitive denial redirects - 'pending' waits for the
    // entitlement fetch and a query error fails open (never ejects).
    if (currentUser && accessState === 'denied') {
      applyRedirect(router.history, fallbackPath, '/new');
    }
  }, [currentUser, pathname, navigate, router, requireAdmin, accessState, fallbackPath]);

  // Show login page if on login route
  if (pathname === '/login') {
    return <>{children}</>;
  }

  // Don't render children until we have a user (prevents flash)
  if (!currentUser) {
    return null;
  }

  // Don't render if admin required but user isn't admin
  if (requireAdmin && !currentUser.isAdmin) {
    return null;
  }

  // Pending entitlement fetch and denial both render null (denial redirects
  // from the effect above).
  if (accessState !== 'satisfied') {
    return null;
  }

  return <>{children}</>;
};

export default RestrictedPage;
