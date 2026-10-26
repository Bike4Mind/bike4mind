import { CreditHolderType, hasDeveloperUserTag } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { SubscriptionOwnerType } from '@client/lib/subscriptions/types';
import { subscriptionRepository } from '@server/models/Subscription';
import { ladderRateTier, resolveUserRateTier, type RateTierUser } from '@server/utils/userRateTier';

/** Values of the `apiKeyAccess` admin setting (settings.ts). */
export type ApiKeyAccessMode = 'all' | 'paid' | 'disabled';

export const API_KEY_ACCESS_DENIED_MESSAGE = 'API keys require an active paid subscription';

/** Who a key bills. Org-billed keys are paid for by the org, so its plan counts too. */
export interface ApiKeyBillingRef {
  billingOwnerType?: CreditHolderType;
  organizationId?: string;
}

/** Mirrors the setting's default in settings.ts: paid-only on hosted, open on self-host. */
function defaultMode(): ApiKeyAccessMode {
  return process.env.B4M_SELF_HOST === 'true' ? 'all' : 'paid';
}

function parseMode(value: unknown): ApiKeyAccessMode {
  return value === 'all' || value === 'paid' || value === 'disabled' ? value : defaultMode();
}

async function readMode(): Promise<ApiKeyAccessMode> {
  // Uncached so flipping the switch takes effect on the next request in every process,
  // not after the 5-minute settings-cache TTL. One indexed read.
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { skipCache: true, names: ['apiKeyAccess'] }
  );
  return parseMode(getSettingsValue('apiKeyAccess', settings));
}

async function orgHasPaidPlan(organizationId: string): Promise<boolean> {
  const rows = await subscriptionRepository.findActiveSubscriptionsByOwners(SubscriptionOwnerType.Organization, [
    organizationId,
  ]);
  return ladderRateTier(rows) !== 'free';
}

/**
 * Whether `user` may mint or use a personal API key under the `apiKeyAccess` setting.
 * Admins and developer-tagged users always pass. Under `paid`, the user needs a Basic/Pro
 * ladder subscription (own or org seat, see getActiveSubscriptionsForUser), or the key is
 * org-billed and that org holds one. A setting or subscription read error propagates: the
 * caller fails closed with a 5xx (toApiKeyAuthError), never an allow and never a 403 that
 * would tell a machine client its key is bad.
 */
export async function isApiKeyAccessAllowed(user: RateTierUser, billing?: ApiKeyBillingRef): Promise<boolean> {
  if (user.isAdmin || hasDeveloperUserTag(user.tags)) return true;

  const mode = await readMode();
  if (mode === 'all') return true;
  if (mode === 'disabled') return false;

  const tier = await resolveUserRateTier(user);
  if (tier !== 'free') return true;

  if (billing?.billingOwnerType === CreditHolderType.Organization && billing.organizationId) {
    return orgHasPaidPlan(billing.organizationId);
  }
  return false;
}

/** Throws ForbiddenError when {@link isApiKeyAccessAllowed} denies. */
export async function assertApiKeyAccessAllowed(user: RateTierUser, billing?: ApiKeyBillingRef): Promise<void> {
  if (!(await isApiKeyAccessAllowed(user, billing))) {
    throw new ForbiddenError(API_KEY_ACCESS_DENIED_MESSAGE);
  }
}
