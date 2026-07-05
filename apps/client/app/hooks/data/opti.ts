import { useUser } from '@client/app/contexts/UserContext';
import { userIsDeveloper } from '@client/app/utils/user';
import { useEntitlements } from './entitlements';

/**
 * Client-side OptiHashi access predicate - the single source of truth for
 * showing Opti surfaces (sidenav launch points). Mirrors the enforced server
 * gate `requestHasOptiAccess` (`@bike4mind/premium-optihashi/server`):
 *
 *   admin || developer || holds `optihashi:pro`
 *
 * The resolved entitlement list already folds in the `opti -> optihashi:pro`
 * TAG_GRANTS bridge AND the domain-based entitlement grant, so a tag-less user
 * (who could never satisfy the legacy `Opti`-tag check) sees the entry. The
 * `optihashi:pro` literal is sanctioned here via the boundary allowlist
 * (scripts/libreoncology-core-allowlist.txt, Check 4) so it stays out of the
 * individual nav components.
 *
 * Synchronous fast path: admin, developer, and the legacy `Opti` tag all resolve
 * from already-loaded user state, with NO dependency on the async entitlement
 * fetch. This preserves the pre-cutover behavior for those users - no first-paint
 * window where the Sidenav entry is hidden or the logo click routes off-app while
 * `/api/entitlements` is still loading (the regression a bare entitlement check
 * introduced for the common Opti-tagged user). Only a tag-less holder - a
 * domain-based entitlement grantee with no synchronous signal - falls through to the
 * entitlement arm, and the fetch is skipped entirely when the fast path grants.
 */
export function useOptiAccess(): boolean {
  const currentUser = useUser(s => s.currentUser);
  const isAdmin = useUser(s => s.isAdmin);
  const syncGranted =
    isAdmin ||
    userIsDeveloper(currentUser) ||
    // trim()+toLowerCase() mirrors the registry's `normalizeTag`, so a stray-whitespace
    // tag still takes the synchronous fast path instead of forcing an entitlement fetch.
    (currentUser?.tags ?? []).some(tag => tag.trim().toLowerCase() === 'opti');
  const { data: entitlements } = useEntitlements({ enabled: !syncGranted });
  if (syncGranted) return true;
  return (entitlements ?? []).includes('optihashi:pro');
}
