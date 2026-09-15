import type { PremiumNavDescriptor } from '@client/app/premiumContract';
import { normalizeTag } from '@client/lib/entitlements/registry';

/**
 * Visibility filter for premium-overlay nav launch points (empty array in the
 * open-core fork).
 *
 * Visibility is STRICT: an item shows only when its entitlement / feature-tag
 * gate passes (OR when both are set), with NO admin/developer bypass -
 * deliberately NOT mirroring the route/product gate (RestrictedPage), which
 * bypasses both. Each access gate keeps its own bypass set by design; do not
 * "fix" this predicate.
 *
 * While entitlements load (`entitlements` undefined), gated items stay hidden
 * (no flash). Denied items are HIDDEN, never redirected - the route's own gate
 * handles direct navigation. This function never sees admin status, which
 * structurally guarantees the no-bypass rule.
 */
export function filterVisiblePremiumNavItems(
  items: readonly PremiumNavDescriptor[],
  entitlements: readonly string[] | undefined,
  userTags: readonly string[] | null | undefined
): PremiumNavDescriptor[] {
  return items.filter(item => {
    const gates: boolean[] = [];
    if (item.requireEntitlement) {
      gates.push((entitlements ?? []).includes(normalizeTag(item.requireEntitlement)));
    }
    if (item.requireFeatureTag) {
      const tag = item.requireFeatureTag.toLowerCase();
      gates.push((userTags ?? []).some(t => t.toLowerCase() === tag));
    }
    return gates.length === 0 || gates.some(Boolean);
  });
}
