import type { PremiumNavDescriptor } from '@client/app/premiumContract';
import { normalizeTag } from '@bike4mind/server-utils/lib/entitlements/registry';
import { sanitizeRedirectTo } from '@client/app/utils/authRedirect';

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

/**
 * The premium nav item a post-login `redirectTo` leads to: its path exactly, or a path under it on a segment
 * boundary (`/product/x`, not `/productivity`), the longest match winning. The sign-in and registration pages
 * name that product so a signed-out visitor from one of its links knows where they are headed.
 *
 * The visitor is signed out, so entitlement gates are ignored (the label only echoes the link they followed),
 * but feature-tag-gated items are never named: those are betas not yet public. `.` and `..` segments are
 * resolved first, so the label matches where the redirect lands. A value `sanitizeRedirectTo` rejects, or one
 * no item matches, gives undefined.
 */
export function premiumNavItemForRedirect(
  items: readonly PremiumNavDescriptor[],
  redirectTo: string | null | undefined
): PremiumNavDescriptor | undefined {
  const safe = sanitizeRedirectTo(redirectTo);
  if (!safe) return undefined;
  const path = new URL(safe, 'http://localhost').pathname;
  let best: PremiumNavDescriptor | undefined;
  let bestLength = 0;
  for (const item of items) {
    if (item.requireFeatureTag) continue;
    const base = item.path.split(/[?#]/)[0].replace(/\/+$/, '');
    if (base.length <= bestLength) continue;
    if (path === base || path.startsWith(`${base}/`)) {
      best = item;
      bestLength = base.length;
    }
  }
  return best;
}
