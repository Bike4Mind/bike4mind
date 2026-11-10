import { DATA_LAKE_PLAN_REQUIRED_CODE, hasDeveloperUserTag } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import {
  getRequestActiveSubscriptions,
  type ActiveSubscriptionsRequest,
} from '@bike4mind/server-utils/entitlements/activeSubscriptions';
import { holdsPaidStanding } from '@server/entitlements/paidStanding';
import { isPayingOrganization } from '@server/entitlements/orgPaidStanding';

const SETTING_KEY = 'dataLakeRequirePaidPlan';

export const LAKE_PLAN_REQUIRED_MESSAGE =
  'Data lakes need a paid plan: creating a lake and connecting Google Drive or GitHub to one are ' +
  'available with an active paid subscription, a seat in an organization on a paid plan, or a credit ' +
  'purchase. Upgrade or buy credits, then try again.';

const SETTING_TTL_MS = 30_000;
let cachedSetting: { value: boolean; expiresAt: number } | undefined;

/** Drops the cached setting in this process. */
export function clearLakePlanGateCache(): void {
  cachedSetting = undefined;
}

async function isGateOn(): Promise<boolean> {
  if (cachedSetting && cachedSetting.expiresAt > Date.now()) return cachedSetting.value;
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { skipCache: true, names: [SETTING_KEY] }
  );
  const value = getSettingsValue(SETTING_KEY, settings) === true;
  cachedSetting = { value, expiresAt: Date.now() + SETTING_TTL_MS };
  return value;
}

/**
 * Whether the caller may create a data lake or connect a lake connector. With the
 * `dataLakeRequirePaidPlan` admin setting off (the default) everyone may. On, it admits admins,
 * developers, paid standing (paidStanding.ts: a credit purchase or an active paid subscription,
 * org seats included), and - for an org lake - an organization that itself holds paid standing.
 * `organizationId` must already be authorized for the caller. Read failures propagate (fail closed).
 */
export async function isLakePlanAllowed(req: ActiveSubscriptionsRequest, organizationId?: string): Promise<boolean> {
  const { user } = req;
  if (!user) return false;
  if (user.isAdmin || hasDeveloperUserTag(user.tags)) return true;
  if (!(await isGateOn())) return true;

  const subscriptions = await getRequestActiveSubscriptions(req, { strict: true });
  if (holdsPaidStanding(user, subscriptions)) return true;
  return organizationId ? isPayingOrganization(organizationId) : false;
}

export async function assertLakePlanAllowed(req: ActiveSubscriptionsRequest, organizationId?: string): Promise<void> {
  if (await isLakePlanAllowed(req, organizationId)) return;
  throw new ForbiddenError(LAKE_PLAN_REQUIRED_MESSAGE, { code: DATA_LAKE_PLAN_REQUIRED_CODE });
}
