import { CreditHolderType, type IUserApiKeyRateLimit } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { userApiKeyService } from '@bike4mind/services';
import { getActiveSubscriptionsForUser } from '@server/entitlements/activeSubscriptions';

type ApiKeyTrustUser = userApiKeyService.ApiKeyTrustSubject & { id: string };

/**
 * The API key trust gate's view of one account, with the settings it was judged against.
 * Any active subscription (own or an org seat) counts as paid, the same rows that drive
 * entitlements and the rate tier.
 */
export async function resolveApiKeyTrust(user: ApiKeyTrustUser): Promise<{
  assessment: userApiKeyService.ApiKeyTrustAssessment;
  settings: userApiKeyService.ApiKeyTrustSettings;
}> {
  const settings = await userApiKeyService.loadApiKeyTrustSettings({ adminSettings: adminSettingsRepository });
  const assessment = await userApiKeyService.assessApiKeyTrust(user, {
    settings,
    hasActivePlan: async () => (await getActiveSubscriptionsForUser(user.id)).length > 0,
  });
  return { assessment, settings };
}

/**
 * Request-time ceiling for a personal key whose owner is untrusted, so keys minted before the
 * gate existed are throttled rather than revoked. Lifts on its own once the owner becomes
 * trusted. Org-billed keys are exempt, as they are at mint time. The key's own lower limit wins.
 */
export async function applyUntrustedRateLimit(
  owner: ApiKeyTrustUser,
  key: { rateLimit: IUserApiKeyRateLimit; billingOwnerType?: string }
): Promise<IUserApiKeyRateLimit> {
  if (key.billingOwnerType === CreditHolderType.Organization) return key.rateLimit;
  const { assessment, settings } = await resolveApiKeyTrust(owner);
  if (assessment.status !== 'untrusted') return key.rateLimit;
  return {
    ...key.rateLimit,
    requestsPerMinute: Math.min(key.rateLimit.requestsPerMinute, settings.untrustedRateLimitPerMinute),
  };
}
