import { useUser } from '@client/app/contexts/UserContext';
import { userIsDeveloper } from '@client/app/utils/user';
import { premiumRoutes } from '@client/app/premium-generated/premiumRoutes.generated';
import { useEntitlements } from './entitlements';

// Builds without the overlay (open core) have no /meetings route at all, so every launch
// point must hide regardless of role or the entry dead-ends. Same structural gate the
// Tavern row uses inline, and the reason it is safe to reference the path here: the route
// list is generated, so an absent overlay makes this `false` with no build-time coupling.
const meetingsRouteExists = premiumRoutes.some(route => route.path.startsWith('/meetings'));

/**
 * Client-side access predicate for the Interactive Meetings surface.
 *
 * Modelled on `useOptiAccess` deliberately, including the synchronous fast path, because
 * the two overlays sit in the same place in the rail and an entry that appears a beat late
 * reads as a broken build. It mirrors the overlay's own server gate:
 *
 *   admin || developer || holds `meetings:pro`
 *
 * The resolved entitlement list already folds in the `meetings -> meetings:pro` TAG_GRANTS
 * bridge, so a user granted through the admin Product Access panel is covered by the
 * entitlement arm without needing a second tag.
 *
 * The fast path matters for the same reason it does for Opti: admin and developer resolve
 * from already-loaded user state, so those users never see a first-paint window where the
 * row is missing while `/api/entitlements` is still in flight. The fetch is skipped
 * entirely when the fast path grants, and skipped when the route does not exist at all.
 *
 * Note this is NOT the same predicate as `filterVisiblePremiumNavItems`, which has no admin
 * bypass by design. That one governs the generic, overlay-declared nav rows; this governs a
 * core-owned rail row, which is the pattern Opti established and which an administrator
 * needs in order to find the surface at all before granting anybody the entitlement.
 */
export function useMeetingsAccess(): boolean {
  const currentUser = useUser(s => s.currentUser);
  const isAdmin = useUser(s => s.isAdmin);
  const syncGranted = isAdmin || userIsDeveloper(currentUser);
  const { data: entitlements } = useEntitlements({ enabled: meetingsRouteExists && !syncGranted });
  if (!meetingsRouteExists) return false;
  if (syncGranted) return true;
  return (entitlements ?? []).includes('meetings:pro');
}
