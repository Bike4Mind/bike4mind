import { useUser } from '@client/app/contexts/UserContext';
import { useEntitlements } from '@client/app/hooks/data/entitlements';
import { normalizeTag } from '@client/lib/entitlements/registry';
import { userIsDeveloper } from '@client/app/utils/user';

/** A gate requirement is satisfied, definitively unsatisfied, or still resolving. */
export type EntitlementGateState = 'satisfied' | 'denied' | 'pending';

export interface EntitlementGateResult {
  /**
   * The membership decision for `entitlementKey`, or `undefined` when no key
   * was passed (no requirement to evaluate). `'pending'` while the entitlement
   * query is in flight - callers decide whether pending renders as hidden
   * (nav links) or as a hold-without-redirect (route gates).
   */
  state: EntitlementGateState | undefined;
  /** Admins and developers bypass entitlement checks entirely. */
  bypass: boolean;
}

/**
 * The client-side entitlement membership decision, extracted from
 * `RestrictedPage` so nav-visibility hooks (e.g. premium overlays' membership
 * checks) share one implementation:
 *
 * - bypass = `isAdmin || userIsDeveloper` (no entitlement fetch when bypassed)
 * - otherwise the server-resolved entitlement list (`useEntitlements`) must
 *   contain the normalized key
 * - a query ERROR fails open by design: this gate is UX, not a security
 *   control - the server enforces entitlements on the APIs behind it. A
 *   transient /api/entitlements failure must not eject (or hide the UI from)
 *   a paying user.
 */
export const useEntitlementGate = (entitlementKey?: string): EntitlementGateResult => {
  const { currentUser } = useUser();

  const bypass = !!currentUser && (currentUser.isAdmin || userIsDeveloper(currentUser));

  const entitlementQuery = useEntitlements({
    enabled: !!entitlementKey && !!currentUser && !bypass,
  });

  let state: EntitlementGateState | undefined;
  if (entitlementKey) {
    if (bypass) {
      state = 'satisfied';
    } else if (entitlementQuery.isSuccess) {
      state = (entitlementQuery.data ?? []).includes(normalizeTag(entitlementKey)) ? 'satisfied' : 'denied';
    } else if (entitlementQuery.isError) {
      state = 'satisfied';
    } else {
      state = 'pending';
    }
  }

  return { state, bypass };
};
