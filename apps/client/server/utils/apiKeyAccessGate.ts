import { CreditHolderType, OAUTH_DEVICE_CLIENT_IDS, hasDeveloperUserTag } from '@bike4mind/common';
import { adminSettingsRepository, authSessionRepository } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { SubscriptionOwnerType } from '@client/lib/subscriptions/types';
import { subscriptionRepository } from '@server/models/Subscription';
import {
  getActiveSubscriptionsForUser,
  type ActiveSubscriptionsRequest,
} from '@server/entitlements/activeSubscriptions';
import { hasPaidSubscription, type RateTierUser } from '@server/utils/userRateTier';

/** Values of the `apiKeyAccess` admin setting (settings.ts). */
export type ApiKeyAccessMode = 'all' | 'paid' | 'disabled';

export const API_KEY_ACCESS_DENIED_MESSAGE = 'API keys require an active paid subscription';
export const CLI_ACCESS_DENIED_MESSAGE = 'The CLI and desktop app require an active paid subscription';

/** OAuth error code for a refusal by this switch, distinct from a revoked or denied grant. */
export const SUBSCRIPTION_REQUIRED_ERROR = 'subscription_required';

/** The key being minted or used: who it bills, and whether an admin provisioned it. */
export interface ApiKeyBillingRef {
  billingOwnerType?: CreditHolderType;
  organizationId?: string;
  /** Set only by the admin generate-api-key route (metadata.createdByUserId). */
  createdByUserId?: string;
}

/** A flip reaches every process within this window without a settings read per request. */
const MODE_CACHE_TTL_MS = 30_000;
let modeCache: { mode: ApiKeyAccessMode; expiresAt: number } | undefined;

/** Drops the cached setting, e.g. in tests or right after an admin write in this process. */
export function clearApiKeyAccessModeCache(): void {
  modeCache = undefined;
}

async function readMode(): Promise<ApiKeyAccessMode> {
  if (modeCache && modeCache.expiresAt > Date.now()) return modeCache.mode;
  // Bypasses the shared 5-minute settings cache; one indexed read per process per TTL.
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { skipCache: true, names: ['apiKeyAccess'] }
  );
  // getSettingsValue resolves an unset or invalid stored value to the settings.ts default.
  const value = getSettingsValue('apiKeyAccess', settings);
  const mode: ApiKeyAccessMode = value === 'all' || value === 'disabled' ? value : 'paid';
  modeCache = { mode, expiresAt: Date.now() + MODE_CACHE_TTL_MS };
  return mode;
}

/**
 * The user's active subscriptions, through the request memo when there is one. Strict, so an
 * org-leg read error reaches the caller as a 5xx instead of under-granting a seat member to a
 * terminal 403. A successful read seeds `req.activeSubscriptions` for the rate limiter and
 * entitlement gate later in the same request.
 */
async function userSubscriptions(user: RateTierUser, req?: ActiveSubscriptionsRequest) {
  const sameUser = req && (!req.user || req.user.id === user.id);
  if (sameUser && req.activeSubscriptions) return req.activeSubscriptions;
  const rows = await getActiveSubscriptionsForUser(user.id, { strict: true });
  if (sameUser) req.activeSubscriptions = rows;
  return rows;
}

async function orgHasPaidPlan(organizationId: string): Promise<boolean> {
  const rows = await subscriptionRepository.findActiveSubscriptionsByOwners(SubscriptionOwnerType.Organization, [
    organizationId,
  ]);
  return hasPaidSubscription(rows);
}

/**
 * Whether `user` may mint or use a personal API key under the `apiKeyAccess` setting.
 * Admins, developer-tagged users and admin-provisioned keys always pass. Under `paid`, the
 * user needs an active paid plan (own or org seat, see getActiveSubscriptionsForUser), or the
 * key is org-billed and that org holds one. A setting or subscription read error propagates:
 * the caller fails closed with a 5xx (toApiKeyAuthError), never an allow and never a 403 that
 * would tell a machine client its key is bad.
 */
export async function isApiKeyAccessAllowed(
  user: RateTierUser,
  key?: ApiKeyBillingRef,
  req?: ActiveSubscriptionsRequest
): Promise<boolean> {
  if (user.isAdmin || hasDeveloperUserTag(user.tags)) return true;
  // An admin chose to provision this key for the account, so it is not self-service access.
  if (key?.createdByUserId) return true;

  const mode = await readMode();
  if (mode === 'all') return true;
  if (mode === 'disabled') return false;

  if (hasPaidSubscription(await userSubscriptions(user, req))) return true;

  if (key?.billingOwnerType === CreditHolderType.Organization && key.organizationId) {
    return orgHasPaidPlan(key.organizationId);
  }
  return false;
}

/** Throws ForbiddenError when {@link isApiKeyAccessAllowed} denies. */
export async function assertApiKeyAccessAllowed(
  user: RateTierUser,
  key?: ApiKeyBillingRef,
  req?: ActiveSubscriptionsRequest
): Promise<void> {
  if (!(await isApiKeyAccessAllowed(user, key, req))) {
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
 * The same switch for CLI and desktop sessions, which authenticate with a session JWT rather
 * than a key. Browser sessions are untouched. Reads the auth session first (one indexed read)
 * so web traffic never pays the subscription reads. A token without a `sid` predates server
 * sessions and is left alone; it expires on its own.
 * @throws ForbiddenError when the session is a device-flow session the setting denies.
 */
export async function assertCliSessionAllowed(user: RateTierUser, sid: string | undefined): Promise<void> {
  if (!sid || user.isAdmin || hasDeveloperUserTag(user.tags)) return;
  const session = await authSessionRepository.findBySid(sid);
  if (!isDeviceClientSession(session)) return;
  if (!(await isApiKeyAccessAllowed(user))) {
    throw new ForbiddenError(CLI_ACCESS_DENIED_MESSAGE);
  }
}
