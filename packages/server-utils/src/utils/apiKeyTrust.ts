import { CreditHolderType, type IUserApiKeyRateLimit, type OAuthClientUnpaidAccountLimits } from '@bike4mind/common';
import { adminSettingsRepository, oauthClientRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { userApiKeyService } from '@bike4mind/services';
import {
  getActiveSubscriptionsForUser,
  getRequestActiveSubscriptions,
  type ActiveSubscriptionsRequest,
} from '../entitlements/activeSubscriptions';

type ApiKeyTrustUser = userApiKeyService.ApiKeyTrustSubject & { id: string; isSystem?: boolean };

const CLIENT_LIMITS_TTL_MS = 60_000;
const clientLimitsCache = new Map<string, { value: OAuthClientUnpaidAccountLimits | undefined; expiresAt: number }>();

/** Test hook: drops the in-process client limits cache. */
export function clearUnpaidAccountLimitsCache(): void {
  clientLimitsCache.clear();
}

/** A failed lookup resolves to undefined (the global clamp) and is not cached. */
async function loadUnpaidAccountLimits(clientId: string): Promise<OAuthClientUnpaidAccountLimits | undefined> {
  const cached = clientLimitsCache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const client = await oauthClientRepository.findByClientId(clientId);
    const value = client?.unpaidAccountLimits
      ? {
          requestsPerMinute: client.unpaidAccountLimits.requestsPerMinute,
          requestsPerDay: client.unpaidAccountLimits.requestsPerDay,
          tokensPerMinute: client.unpaidAccountLimits.tokensPerMinute,
          maxConcurrent: client.unpaidAccountLimits.maxConcurrent,
        }
      : undefined;
    clientLimitsCache.set(clientId, { value, expiresAt: Date.now() + CLIENT_LIMITS_TTL_MS });
    return value;
  } catch (error) {
    Logger.globalInstance.warn('OAuth client unpaid account limits lookup failed; using global untrusted limits', {
      clientId,
      error,
    });
    return undefined;
  }
}

/**
 * The API key trust gate's view of one account, with the settings it was judged against.
 * Any active subscription (own or an org seat) counts as paid, the same rows that drive
 * entitlements and the rate tier. Pass `req` when `user` is `req.user`, so the subscription read
 * is shared with the rest of the request. A failed read throws rather than guessing either way.
 * Account age counts per the apiKeyAccountAgeTrustsKeys setting; `honorAccountAge` overrides it for
 * callers that are not about API keys (the outbound action gate always counts it).
 */
export async function resolveApiKeyTrust(
  user: ApiKeyTrustUser,
  req?: ActiveSubscriptionsRequest,
  options: { honorAccountAge?: boolean } = {}
): Promise<{
  assessment: userApiKeyService.ApiKeyTrustAssessment;
  settings: Awaited<ReturnType<typeof userApiKeyService.loadApiKeyTrustSettings>>;
}> {
  const settings = await userApiKeyService.loadApiKeyTrustSettings({ adminSettings: adminSettingsRepository });
  const assessment = await userApiKeyService.assessApiKeyTrust(user, {
    settings,
    honorAccountAge: options.honorAccountAge ?? settings.accountAgeTrustsKeys,
    hasActivePlan: async () =>
      (await (req ? getRequestActiveSubscriptions(req) : getActiveSubscriptionsForUser(user.id))).length > 0,
  });
  return { assessment, settings };
}

/**
 * Request-time ceilings (per minute, and per day when that setting is on) for a personal key whose
 * owner passes the API access policy but is untrusted, so keys minted before the gate existed are
 * throttled rather than revoked.
 * Lifts on its own once the owner becomes trusted. Org-billed keys and keys owned by a system account
 * (e.g. the Overwatch ingest user, which cannot sign in or mint keys itself) are exempt and keep the
 * limits they were minted with. Mint time skips trust for the shared system user (createUserApiKey's
 * systemUserId check); here any owner flagged isSystem is exempt. The key's own lower limit wins.
 * `ownerUntrusted` lets a caller skip re-judging the owner.
 * An exchange key's OAuth client may carry `unpaidAccountLimits`, which replace the global untrusted
 * ceilings and are returned so callers can apply the token and concurrency values.
 */
export async function resolveUntrustedKeyLimits(
  owner: ApiKeyTrustUser,
  key: { rateLimit: IUserApiKeyRateLimit; billingOwnerType?: string; oauthExchangeClientId?: string },
  req?: ActiveSubscriptionsRequest
): Promise<{
  rateLimit: IUserApiKeyRateLimit;
  ownerUntrusted: boolean;
  unpaidAccountLimits?: OAuthClientUnpaidAccountLimits;
}> {
  if (key.billingOwnerType === CreditHolderType.Organization || owner.isSystem === true)
    return { rateLimit: key.rateLimit, ownerUntrusted: false };
  const { assessment, settings } = await resolveApiKeyTrust(owner, req);
  if (assessment.status !== 'untrusted') return { rateLimit: key.rateLimit, ownerUntrusted: false };
  const unpaidAccountLimits = key.oauthExchangeClientId
    ? await loadUnpaidAccountLimits(key.oauthExchangeClientId)
    : undefined;
  const perMinute = unpaidAccountLimits?.requestsPerMinute ?? settings.untrustedRateLimitPerMinute;
  const perDay = unpaidAccountLimits?.requestsPerDay ?? settings.untrustedRequestsPerDay;
  return {
    ownerUntrusted: true,
    ...(unpaidAccountLimits && { unpaidAccountLimits }),
    rateLimit: {
      ...key.rateLimit,
      requestsPerMinute: Math.min(key.rateLimit.requestsPerMinute, perMinute),
      ...(perDay > 0 && { requestsPerDay: Math.min(key.rateLimit.requestsPerDay, perDay) }),
    },
  };
}

/** The rate limit half of {@link resolveUntrustedKeyLimits}. */
export async function applyUntrustedRateLimit(
  owner: ApiKeyTrustUser,
  key: { rateLimit: IUserApiKeyRateLimit; billingOwnerType?: string; oauthExchangeClientId?: string },
  req?: ActiveSubscriptionsRequest
): Promise<IUserApiKeyRateLimit> {
  return (await resolveUntrustedKeyLimits(owner, key, req)).rateLimit;
}
