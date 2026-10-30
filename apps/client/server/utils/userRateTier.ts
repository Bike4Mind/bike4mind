import { hasDeveloperUserTag, type SettingKey } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import {
  getActiveSubscriptionsForUser,
  getRequestActiveSubscriptions,
  type ActiveSubscription,
  type ActiveSubscriptionsRequest,
} from '@server/entitlements/activeSubscriptions';
import { getEntitlingPlanByPriceId, getHighestLadderTier } from '@client/lib/userSubscriptions/utils';
import { UserSubscriptionTier } from '@client/lib/userSubscriptions/types';
import { isDevelopment } from '@bike4mind/server-utils/utils/config';

/**
 * The rate-limit tier a request is charged against. Derived from the
 * caller's ACTIVE paid subscriptions + admin/developer status - NOT a
 * materialized field. Mirrors the derive-on-read model of `entitlements`.
 *
 * `bypass` - admins and developer-tagged users (internal), never rate limited.
 * `pro` / `basic` - highest tier among the user's active subscriptions,
 *   including org seats (`getActiveSubscriptionsForUser`; a Team plan is Pro).
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
 * Floor applied when the tier or its setting cannot be resolved: the Free-tier
 * default (never `Infinity`), so a read failure never disables the limiter. It
 * does not honor an admin-set Free limit of 0, because the tier is unknown then
 * and blocking would lock out paid users during an outage.
 */
const FALLBACK_RATE_LIMIT_PER_MIN = 10;

/** Per-tier admin setting key holding that tier's requests-per-minute limit. */
const TIER_SETTING_KEY = {
  free: 'apiRateLimitFreePerMin',
  basic: 'apiRateLimitBasicPerMin',
  pro: 'apiRateLimitProPerMin',
} as const satisfies Record<Exclude<UserRateTier, 'bypass'>, SettingKey>;

/**
 * Resolve the caller's rate-limit tier. Costs two indexed reads for non-bypass
 * users (three with an org membership) - negligible next to the multi-second LLM
 * call these routes make. Pass the request to resolve through its per-request
 * memo, so the handler's entitlement gate reuses these reads instead of repeating them.
 */
export async function resolveUserRateTier(
  user: RateTierUser,
  req?: ActiveSubscriptionsRequest,
  options?: { strict?: boolean }
): Promise<UserRateTier> {
  if (user.isAdmin || hasDeveloperUserTag(user.tags)) return 'bypass';

  const activeSubscriptions =
    req?.user?.id === user.id
      ? await getRequestActiveSubscriptions(req, options)
      : await getActiveSubscriptionsForUser(user.id, options);

  return ladderRateTier(activeSubscriptions);
}

/**
 * Whether any active subscription is on a paid plan, ladder or not. Distinct from the rate
 * tier: a standalone plan is paid but confers no tier.
 */
export function hasPaidSubscription(activeSubscriptions: readonly Pick<ActiveSubscription, 'priceId'>[]): boolean {
  return activeSubscriptions.some(subscription => getEntitlingPlanByPriceId(subscription.priceId) !== undefined);
}

/**
 * The HIGHEST ladder tier across a set of active subscriptions. Plans with no `tier`
 * (standalone single-product plans sold off the main ladder) are not on the ladder and
 * don't confer a tier - they fall through to `free` unless another subscription grants one.
 */
export function ladderRateTier(
  activeSubscriptions: readonly Pick<ActiveSubscription, 'priceId'>[]
): Exclude<UserRateTier, 'bypass'> {
  // Same ladder read as the `plan:paid` entitlement (@server/entitlements), except that a credit
  // purchase also grants `plan:paid` but leaves the rate tier at `free`.
  const highestTier = getHighestLadderTier(activeSubscriptions);

  if (highestTier === UserSubscriptionTier.Pro) return 'pro';
  if (highestTier === UserSubscriptionTier.Basic) return 'basic';
  return 'free';
}

/**
 * Per-process cache of the tier settings read. This runs on every request to per-keystroke helpers
 * (rapid-reply, optimize-input, semantic search), so it bypasses the shared 5-minute settings cache
 * with its own short TTL: an admin's 0 (block) or its lift reaches every process within the TTL.
 */
const TIER_SETTINGS_CACHE_TTL_MS = 15_000;
const tierSettingsCache = new Map<string, { settings: Record<string, string>; expiresAt: number }>();

/** Test-only: drop the in-process cache so a mocked setting in one test cannot leak into the next. */
export const __resetTierSettingsCache = (): void => tierSettingsCache.clear();

async function readTierSettings(settingKey: SettingKey): Promise<Record<string, string>> {
  const now = Date.now();
  const cached = tierSettingsCache.get(settingKey);
  if (cached && cached.expiresAt > now) return cached.settings;
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { skipCache: true, names: [settingKey] }
  );
  tierSettingsCache.set(settingKey, { settings, expiresAt: now + TIER_SETTINGS_CACHE_TTL_MS });
  return settings;
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
 * is a can't-happen post-auth; we fail CLOSED to the fallback floor.
 */
export async function resolveUserRateLimitPerMin(
  user: RateTierUser | undefined,
  req?: ActiveSubscriptionsRequest
): Promise<number> {
  // Preserve local-dev ergonomics - never rate limit on a dev server.
  if (isDevelopment()) return Infinity;

  // No authenticated user (unreachable post-auth) - fail closed, don't bypass.
  if (!user) return FALLBACK_RATE_LIMIT_PER_MIN;

  try {
    const tier = await resolveUserRateTier(user, req);
    if (tier === 'bypass') return Infinity;

    const settingKey = TIER_SETTING_KEY[tier];
    const settings = await readTierSettings(settingKey);
    // `??` keeps an explicit 0, which the middleware treats as "block".
    return getSettingsValue(settingKey, settings) ?? FALLBACK_RATE_LIMIT_PER_MIN;
  } catch (error) {
    // This runs in the rate-limit middleware, BEFORE the handler. A transient
    // subscription/settings read failure must not turn every request into a 500
    // - apply the fallback floor so the limiter stays ON (fail closed).
    Logger.globalInstance.warn('[rateTier] resolution failed; applying fallback floor', { error });
    return FALLBACK_RATE_LIMIT_PER_MIN;
  }
}
