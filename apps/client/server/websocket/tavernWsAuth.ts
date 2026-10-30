import { User } from '@bike4mind/database';
import { canAccessTavern } from '@bike4mind/common';

/**
 * Tavern access gate for WebSocket action handlers - the WS-layer counterpart
 * to the HTTP-side `ensureTavernAccess` (packages/server-utils/src/utils/errors.ts).
 *
 * The `$connect` handler authenticates *identity* (JWT or API key) but does not
 * check Tavern access, and the per-action bridge/identity checks only prove who
 * the caller is and that they own the target resource - not that they may reach
 * the Tavern at all. This loads the resolved user and applies the shared
 * `canAccessTavern` predicate (admin OR 'tavern' tag), so the WS action surface
 * enforces the same grant as the HTTP surface and the client route guard - the
 * three can never drift (the fail-open class that motivated `canAccessTavern`).
 *
 * Returns a boolean rather than throwing, matching the explicit-status-code
 * style of the WS handlers: a denied caller is logged with the handler's own
 * tag and answered with a 403 before any scene broadcast fires. The projection
 * is limited to the two fields the predicate reads.
 *
 * Cost: one projected {isAdmin,tags} PK lookup per gated action. This is
 * intentionally stateless and always-fresh - no memoization by design. The
 * lookup is cheap at current volume, and a cached result would be no fresher
 * than (and would add a staleness window on top of) the JWT/API-key lifetime
 * that already fixes the caller's identity, so caching authorization here would
 * trade correctness for a saving the access pattern does not need.
 *
 * Reads the stored admin role on purpose, without `withholdAdminRole`
 * (server/auth/apiKeyAdminScope.ts), even though a bridge key never carries `admin:*`.
 * A `cc-bridge` key is only minted by /api/cc-bridge/pair and /download, both behind
 * `ensureTavernAccess`, and the scope is good for nothing but these gated actions, so the
 * admin role buys it only the Tavern access it was minted for. Withholding it would lock
 * out every admin without the 'tavern' tag. Demoting the owner still takes effect here.
 */
export async function connectionUserCanAccessTavern(userId: string): Promise<boolean> {
  const user = await User.findById(userId, { isAdmin: 1, tags: 1 }).lean();
  return canAccessTavern(user);
}
