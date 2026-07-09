/**
 * Generic entitlement resolver (ACCESS_MODEL.md §3.1) - derive-on-read.
 *
 * Entitlements are computed at check time from (a) the user's ACTIVE
 * subscriptions (priceId -> key via the registry) and (b) the user's tags
 * (1:1 passthrough + comp-tag remap). Nothing is materialized, so revocation
 * is automatic when a subscription lapses and admin-granted Subscription rows
 * (`source: 'admin_grant'`, real priceId) grant with no extra code.
 *
 * Status policy (deliberate v1 product decision): only `status === 'active'`
 * grants - `past_due` (no dunning grace) and `trialing` deny. Changing that
 * means replacing `findActiveUserSubscriptions` with a status-allowlist query
 * here, not widening the repository method.
 *
 * Owner scope: User-owned subscriptions only. The org-seat fast-follow
 * (ACCESS_MODEL §3.2) adds seat-membership resolution HERE - callers never
 * change. Note the webhook invalidation fan-out for seats is separate work.
 */
import { resolveEntitlements, normalizeTag } from '@client/lib/entitlements/registry';
import type { EntitlementKey } from '@client/lib/entitlements/types';
import { subscriptionRepository } from '@server/models/Subscription';
import { partnerEntitlementsForEmail } from '@server/entitlements/partnerRules';
import type { IUserDocument } from '@bike4mind/common';

/**
 * Minimal structural request shape for the entitlement helpers. Using a plain
 * interface instead of Express.Request<...> keeps this module compilable from
 * cross-package contexts (e.g. the premium overlay) where @types/passport
 * augments req.user as optional - the TS2345/TS18048 conflict with global.d.ts
 * never surfaces because express types are not imported here at all. Any
 * Express.Request (or Next.js request) is structurally assignable to this.
 */
export interface EntitlementRequest {
  user?: IUserDocument;
  entitlements?: EntitlementKey[];
}

export interface EntitlementUser {
  id: string;
  tags?: string[] | null;
  isAdmin?: boolean;
  /** Granting a domain entitlement requires BOTH (verified-email gate). */
  email?: string | null;
  emailVerified?: boolean | null;
}

/**
 * All entitlement keys the user currently holds (subscription- and
 * tag-derived). Does NOT apply the admin bypass - that is a gate concern
 * (`userHasEntitlement`), and the raw list is what `/api/entitlements`
 * returns to the client.
 *
 * Quest 3 (route-gating) note: when this lands on every libonc API request,
 * memoize per request (`req.entitlements`, following the `req.ability`
 * pattern) at the call site.
 */
export async function getUserEntitlements(user: EntitlementUser): Promise<EntitlementKey[]> {
  // Both reads are independent - run them together to avoid serializing two round-trips.
  const [activeSubscriptions, partnerKeys] = await Promise.all([
    subscriptionRepository.findActiveUserSubscriptions(user.id),
    partnerEntitlementsForEmail(user.email, user.emailVerified),
  ]);
  // DB-backed partner rules (issue #293) union with the pure registry grants
  // (subscription + tag + env-domain). Additive so an env-configured domain
  // keeps working until it is migrated into the PartnerSignupRule collection.
  const keys = new Set(
    resolveEntitlements({
      tags: user.tags ?? [],
      activePriceIds: activeSubscriptions.map(subscription => subscription.priceId),
      email: user.email,
      emailVerified: user.emailVerified,
    })
  );
  for (const key of partnerKeys) {
    keys.add(key);
  }
  return [...keys];
}

/**
 * Whether the user holds the entitlement. Admins bypass.
 *
 * Bypass-parity warning for Quest 3 (route-gating): the client gate
 * (`RestrictedPage`) bypasses for admin AND developer; this resolver
 * bypasses for admin ONLY. Call sites wiring this into APIs must decide
 * developer parity explicitly (e.g. `|| hasDeveloperUserTag(user.tags)`,
 * mirroring the product access helpers that already consume that shared
 * predicate) - otherwise a developer who passes the UI gate will 403 on
 * the API, the exact route-vs-API drift `hasDeveloperUserTag` was promoted
 * to `@bike4mind/common` to prevent.
 */
export async function userHasEntitlement(user: EntitlementUser, key: EntitlementKey): Promise<boolean> {
  if (user.isAdmin) return true;
  const entitlements = await getUserEntitlements(user);
  return entitlements.includes(normalizeTag(key));
}

/**
 * Per-request memoized entitlement list - the Quest 3 `req.entitlements` cache,
 * mirroring the `req.ability` pattern (`server/auth/auth.ts`). Resolving
 * entitlements costs a subscription DB read, so it is computed LAZILY per
 * request (only gating routes pay the query - NOT every API request, which is
 * why this is not set in global auth middleware like `req.ability`) and cached
 * on `req.entitlements` so repeated checks within one request reuse the result.
 *
 * `??=` is correct here: an empty list is a valid, non-nullish result that must
 * memoize (`||=` would re-query on every empty-entitlement request).
 */
export async function getRequestEntitlements(req: EntitlementRequest): Promise<EntitlementKey[]> {
  // Fail closed: a nullish user holds nothing (empty list = deny). baseApi populates
  // req.user before gating routes call this, so `!` below is safe once past the guard;
  // the guard is defense-in-depth for a future caller that forgets to check.
  if (!req.user) return [];
  return (req.entitlements ??= await getUserEntitlements(req.user));
}

/**
 * Generic request-scoped entitlement gate. Admins bypass (a platform-neutral
 * default, matching `userHasEntitlement`); otherwise the request must hold
 * `key`. Memoizes via `getRequestEntitlements`.
 *
 * Developer parity is intentionally NOT baked in here: "any developer-tagged
 * user bypasses any entitlement" is a product-level affordance, not a sound
 * platform default for every future consumer (a paid entitlement may
 * legitimately want to charge developers). Call sites that want the client
 * `RestrictedPage` developer bypass add it explicitly with the shared
 * `hasDeveloperUserTag` predicate (`@bike4mind/common`).
 */
export async function requestHasEntitlement(req: EntitlementRequest, key: EntitlementKey): Promise<boolean> {
  // Fail closed at this shared choke point: every product gate funnels through here,
  // so a nullish user (defensive - baseApi populates req.user in production) denies
  // rather than throwing on the downstream getUserEntitlements dereference.
  if (!req.user) return false;
  if (req.user.isAdmin) return true;
  return (await getRequestEntitlements(req)).includes(normalizeTag(key));
}
