import { CreditHolderType, type IUserApiKeyRateLimit } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { userApiKeyService } from '@bike4mind/services';
import {
  getActiveSubscriptionsForUser,
  getRequestActiveSubscriptions,
  type ActiveSubscriptionsRequest,
} from '@server/entitlements/activeSubscriptions';

type ApiKeyTrustUser = userApiKeyService.ApiKeyTrustSubject & { id: string };

/**
 * The API key trust gate's view of one account, with the settings it was judged against.
 * Any active subscription (own or an org seat) counts as paid, the same rows that drive
 * entitlements and the rate tier. Pass `req` when `user` is `req.user`, so the subscription read
 * is shared with the rest of the request. A failed read throws rather than guessing either way.
 */
export async function resolveApiKeyTrust(
  user: ApiKeyTrustUser,
  req?: ActiveSubscriptionsRequest
): Promise<{
  assessment: userApiKeyService.ApiKeyTrustAssessment;
  settings: Awaited<ReturnType<typeof userApiKeyService.loadApiKeyTrustSettings>>;
}> {
  const settings = await userApiKeyService.loadApiKeyTrustSettings({ adminSettings: adminSettingsRepository });
  const assessment = await userApiKeyService.assessApiKeyTrust(user, {
    settings,
    hasActivePlan: async () =>
      (await (req ? getRequestActiveSubscriptions(req) : getActiveSubscriptionsForUser(user.id))).length > 0,
  });
  return { assessment, settings };
}

/**
 * Request-time ceilings (per minute, and per day when that setting is on) for a personal key whose
 * owner passes the API access policy but is untrusted, so keys minted before the gate existed are
 * throttled rather than revoked.
 * Lifts on its own once the owner becomes trusted. Org-billed keys are exempt, as they are at mint
 * time. The key's own lower limit wins. `ownerUntrusted` lets a caller skip re-judging the owner.
 */
export async function resolveUntrustedKeyLimits(
  owner: ApiKeyTrustUser,
  key: { rateLimit: IUserApiKeyRateLimit; billingOwnerType?: string },
  req?: ActiveSubscriptionsRequest
): Promise<{ rateLimit: IUserApiKeyRateLimit; ownerUntrusted: boolean }> {
  if (key.billingOwnerType === CreditHolderType.Organization)
    return { rateLimit: key.rateLimit, ownerUntrusted: false };
  const { assessment, settings } = await resolveApiKeyTrust(owner, req);
  if (assessment.status !== 'untrusted') return { rateLimit: key.rateLimit, ownerUntrusted: false };
  return {
    ownerUntrusted: true,
    rateLimit: {
      ...key.rateLimit,
      requestsPerMinute: Math.min(key.rateLimit.requestsPerMinute, settings.untrustedRateLimitPerMinute),
      ...(settings.untrustedRequestsPerDay > 0 && {
        requestsPerDay: Math.min(key.rateLimit.requestsPerDay, settings.untrustedRequestsPerDay),
      }),
    },
  };
}

/** The rate limit half of {@link resolveUntrustedKeyLimits}. */
export async function applyUntrustedRateLimit(
  owner: ApiKeyTrustUser,
  key: { rateLimit: IUserApiKeyRateLimit; billingOwnerType?: string },
  req?: ActiveSubscriptionsRequest
): Promise<IUserApiKeyRateLimit> {
  return (await resolveUntrustedKeyLimits(owner, key, req)).rateLimit;
}
