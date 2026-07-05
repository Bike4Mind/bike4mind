import { hasDeveloperUserTag, type SettingKey } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { subscriptionRepository } from '@server/models/Subscription';
import { SUBSCRIPTION_PLANS_MAP } from '@client/lib/userSubscriptions/constants';
import { UserSubscriptionTier } from '@client/lib/userSubscriptions/types';
import { isDevelopment } from '@server/utils/config';

/**
 * The rate-limit tier a request is charged against. Derived from the
 * caller's ACTIVE paid subscriptions + admin/developer status - NOT a
 * materialized field. Mirrors the derive-on-read model of `entitlements`.
 *
 * `bypass` - admins and developer-tagged users (internal), never rate limited.
 * `pro` / `basic` - highest tier among the user's active subscriptions
 *   (`SUBSCRIPTION_PLANS_MAP[priceId].tier`).
 * `free` - authenticated user with no active paid, ladder-tiered subscription.
 */
export type UserRateTier = 'bypass' | 'pro' | 'basic' | 'free';

/** The minimal user shape the tier resolver needs (a subset of `Express.User`). */
export interface RateTierUser {
  id: string;
  isAdmin?: boolean;
  tags?: string[] | null;
}

/**
 * Fail-safe floor if a tier setting somehow resolves to `undefined`. The
 * schema's `.prefault` makes this practically unreachable, but coalescing to
 * the most-restrictive tier default (never `0`/`Infinity`) guarantees we fail
 * CLOSED rather than accidentally disabling the limit. Mirrors the Free-tier
 * default in `settings.ts`.
 */
const FALLBACK_RATE_LIMIT_PER_MIN = 10;

/** Per-tier admin setting key holding that tier's requests-per-minute limit. */
const TIER_SETTING_KEY = {
  free: 'apiRateLimitFreePerMin',
  basic: 'apiRateLimitBasicPerMin',
  pro: 'apiRateLimitProPerMin',
} as const satisfies Record<Exclude<UserRateTier, 'bypass'>, SettingKey>;

/**
 * Resolve the caller's rate-limit tier. Costs one indexed subscription read for
 * non-bypass users - negligible next to the multi-second LLM call these routes
 * make, and `/opti` already pays an equivalent read via `requestHasOptiAccess`.
 */
export async function resolveUserRateTier(user: RateTierUser): Promise<UserRateTier> {
  if (user.isAdmin || hasDeveloperUserTag(user.tags)) return 'bypass';

  // NOTE: only User-owned subscriptions are considered. A user entitled via an
  // ORG seat (team plan) currently resolves to `free` and receives the most
  // restrictive limit - an under-grant (never a security hole), mirroring the
  // org-seat resolution gap the entitlements layer also defers. Follow-up:
  // widen this to org-owned/seat subscriptions.
  const activeSubscriptions = await subscriptionRepository.findActiveUserSubscriptions(user.id);

  // Take the HIGHEST ladder tier across active subscriptions. Plans with no
  // `tier` (standalone single-product plans sold off the main ladder) are not
  // on the ladder and don't confer a rate tier - they fall through to `free`
  // unless another active subscription grants one.
  let highestTier: UserSubscriptionTier | undefined;
  for (const subscription of activeSubscriptions) {
    const planTier = SUBSCRIPTION_PLANS_MAP[subscription.priceId]?.tier;
    if (planTier !== undefined && (highestTier === undefined || planTier > highestTier)) {
      highestTier = planTier;
    }
  }

  if (highestTier === UserSubscriptionTier.Pro) return 'pro';
  if (highestTier === UserSubscriptionTier.Basic) return 'basic';
  return 'free';
}

/**
 * Resolve the requests-per-minute limit for a user, reading the tier's tunable
 * admin setting. Returns `Infinity` for bypass tiers (admins/developers) and in
 * development, so the middleware skips enforcement. Token/compute spend is
 * bounded separately by the credits system (`enforceCredits`); this caps
 * request VOLUME per user regardless of source IP.
 *
 * Accepts `undefined` because callers pass `req.user`, which the base Express
 * type models as optional even though these routes run behind auth (the
 * non-optional `req.user` augmentation is client-package-local). A missing user
 * is a can't-happen post-auth; we fail CLOSED to the most-restrictive limit.
 */
export async function resolveUserRateLimitPerMin(user: RateTierUser | undefined): Promise<number> {
  // Preserve local-dev ergonomics - never rate limit on a dev server.
  if (isDevelopment()) return Infinity;

  // No authenticated user (unreachable post-auth) - fail closed, don't bypass.
  if (!user) return FALLBACK_RATE_LIMIT_PER_MIN;

  try {
    const tier = await resolveUserRateTier(user);
    if (tier === 'bypass') return Infinity;

    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
    return getSettingsValue(TIER_SETTING_KEY[tier], settings) ?? FALLBACK_RATE_LIMIT_PER_MIN;
  } catch (error) {
    // This runs in the rate-limit middleware, BEFORE the handler. A transient
    // subscription/settings read failure must not turn every request into a 500
    // - apply the most-restrictive floor so the limiter stays ON (fail closed).
    Logger.globalInstance.warn('[rateTier] resolution failed; applying Free-tier floor', { error });
    return FALLBACK_RATE_LIMIT_PER_MIN;
  }
}
