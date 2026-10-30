import {
  CreditHolderType,
  OAUTH_DEVICE_CLIENT_IDS,
  hasDeveloperUserTag,
  type AdminApiKeyAccess,
} from '@bike4mind/common';
import { adminSettingsRepository, authSessionRepository } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { ForbiddenError, UnauthorizedError } from '@bike4mind/server-utils/utils/errors';
import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';
import { subscriptionRepository } from '@server/models/Subscription';
import {
  getActiveSubscriptionsForUser,
  type ActiveSubscriptionsRequest,
} from '@server/entitlements/activeSubscriptions';
import { hasPaidSubscription, type RateTierUser } from '@server/utils/userRateTier';

export type ApiKeyAccessMode = 'all' | 'paid' | 'disabled';

export const API_KEY_ACCESS_DENIED_MESSAGE = 'API keys require an active paid subscription';
export const CLI_ACCESS_DENIED_MESSAGE = 'The CLI and desktop app require an active paid subscription';

/** OAuth error code for a refusal by this switch, distinct from a revoked or denied grant. */
export const SUBSCRIPTION_REQUIRED_ERROR = 'subscription_required';

export type ApiKeyBillingRef = {
  billingOwnerType?: CreditHolderType;
  organizationId?: string;
  /** Trusted validation metadata, never accepted from a mint request. */
  createdByUserId?: string;
};

const MODE_TTL_MS = 30_000;
let cachedMode: { value: ApiKeyAccessMode; expiresAt: number } | undefined;
let modeRead: Promise<ApiKeyAccessMode> | undefined;

/** Drops the cached setting in this process. */
export function clearApiKeyAccessModeCache(): void {
  cachedMode = undefined;
}

async function readMode(): Promise<ApiKeyAccessMode> {
  if (cachedMode && cachedMode.expiresAt > Date.now()) return cachedMode.value;
  if (modeRead) return modeRead;

  // Single-flight the refresh; an expired value never grants access on a failed read.
  modeRead = (async () => {
    const settings = await getSettingsMap(
      { adminSettings: adminSettingsRepository },
      { skipCache: true, names: ['apiKeyAccess'] }
    );
    const value = getSettingsValue('apiKeyAccess', settings);
    const mode = value === 'all' || value === 'disabled' ? value : 'paid';
    cachedMode = { value: mode, expiresAt: Date.now() + MODE_TTL_MS };
    return mode;
  })();
  try {
    return await modeRead;
  } finally {
    modeRead = undefined;
  }
}

async function orgHasPaidPlan(organizationId: string): Promise<boolean> {
  const rows = await subscriptionRepository.findActiveSubscriptionsByOwners(SubscriptionOwnerType.Organization, [
    organizationId,
  ]);
  return hasPaidSubscription(rows);
}

type ApiKeyAccessBasis = AdminApiKeyAccess['basis'];

/** Pass the user document itself: a projection without `lastCreditsPurchasedAt` refuses a credit buyer. */
export type ApiKeyAccessUser = RateTierUser & { lastCreditsPurchasedAt?: Date | null };

// The same "ever bought" signal that grants plan:paid (server/entitlements/index.ts) and
// hasPaidStanding (userApiKeyService/trust.ts).
const hasBoughtCredits = (user: ApiKeyAccessUser): boolean => Boolean(user.lastCreditsPurchasedAt);

/** The paid-mode subscription check shared by the gate and the admin description of it. */
async function hasPaidApiKeyAccess(
  user: RateTierUser,
  billing?: ApiKeyBillingRef,
  req?: ActiveSubscriptionsRequest
): Promise<boolean> {
  const matchingRequest = req && (!req.user || req.user.id === user.id) ? req : undefined;
  const rows =
    matchingRequest?.activeSubscriptionsStrict && matchingRequest.activeSubscriptions
      ? matchingRequest.activeSubscriptions
      : await getActiveSubscriptionsForUser(user.id, { strict: true });
  if (matchingRequest) {
    matchingRequest.activeSubscriptions = rows;
    matchingRequest.activeSubscriptionsStrict = true;
  }
  if (hasPaidSubscription(rows)) return true;

  if (billing?.billingOwnerType === CreditHolderType.Organization && billing.organizationId) {
    return orgHasPaidPlan(billing.organizationId);
  }
  return false;
}

/**
 * Admins, developers and trusted admin-provisioned keys bypass the switch. Paid access includes
 * standalone plans, org seats and a past credit purchase. Read failures propagate so clients get a
 * retryable 5xx.
 */
export async function isApiKeyAccessAllowed(
  user: ApiKeyAccessUser,
  billing?: ApiKeyBillingRef,
  req?: ActiveSubscriptionsRequest
): Promise<boolean> {
  if (user.isAdmin || hasDeveloperUserTag(user.tags) || billing?.createdByUserId) return true;

  const mode = await readMode();
  if (mode === 'all') return true;
  if (mode === 'disabled') return false;

  return hasBoughtCredits(user) || hasPaidApiKeyAccess(user, billing, req);
}

/**
 * Why the gate lets a user mint and use personal keys right now, for the admin profile. Mirrors
 * isApiKeyAccessAllowed for a key with no billing ref (a user's own standalone access); an
 * org-billed or admin-provisioned key can still pass where `allowed` is false.
 */
export async function describeApiKeyAccess(user: ApiKeyAccessUser): Promise<AdminApiKeyAccess> {
  const mode = await readMode();
  const bypass = (basis: ApiKeyAccessBasis): AdminApiKeyAccess => ({ mode, allowed: true, basis });
  if (user.isAdmin) return bypass('admin');
  if (hasDeveloperUserTag(user.tags)) return bypass('developer');
  if (mode === 'all') return bypass('open_to_all');
  if (mode === 'disabled') return { mode, allowed: false, basis: 'disabled' };
  if (hasBoughtCredits(user)) return bypass('credit_purchase');

  const paid = await hasPaidApiKeyAccess(user);
  return { mode, allowed: paid, basis: paid ? 'paid_subscription' : 'no_paid_subscription' };
}

export async function assertApiKeyAccessAllowed(
  user: ApiKeyAccessUser,
  billing?: ApiKeyBillingRef,
  req?: ActiveSubscriptionsRequest
): Promise<void> {
  if (!(await isApiKeyAccessAllowed(user, billing, req))) {
    throw new ForbiddenError(API_KEY_ACCESS_DENIED_MESSAGE);
  }
}

/** True for a session minted by the device flow, i.e. the CLI or desktop app. */
function isDeviceClientSession(session: { createdVia?: string; clientId?: string | null } | null): boolean {
  if (!session) return false;
  return (
    session.createdVia === 'device' || (OAUTH_DEVICE_CLIENT_IDS as readonly string[]).includes(session.clientId ?? '')
  );
}

/**
 * Shared web surfaces gate device sessions; dedicated API/CLI surfaces gate every JWT,
 * including browser tokens and legacy sidless tokens. Session metadata comes from the server.
 */
export async function assertCliSessionAllowed(
  user: ApiKeyAccessUser,
  sid: string | undefined,
  options: { requireApiAccess?: boolean } = {}
): Promise<void> {
  if (user.isAdmin || hasDeveloperUserTag(user.tags)) return;

  if (!options.requireApiAccess) {
    if (!sid) return;
    const session = await authSessionRepository.findBySid(sid);
    if (!session) throw new UnauthorizedError('Session expired');
    if (!isDeviceClientSession(session)) return;
  }

  if (!(await isApiKeyAccessAllowed(user))) {
    throw new ForbiddenError(CLI_ACCESS_DENIED_MESSAGE);
  }
}
