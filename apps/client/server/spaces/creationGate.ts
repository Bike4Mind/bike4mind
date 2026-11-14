import { hasDeveloperUserTag, type IUserDocument } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { getActiveSubscriptionsForUser } from '@bike4mind/server-utils/entitlements/activeSubscriptions';
import { holdsPaidStanding } from '@bike4mind/server-utils/entitlements/paidStanding';

/**
 * Whether the caller may create a Space: a verified email, then admins and developers, then the
 * `SpaceCreationRequiresPaidStanding` setting (off admits everyone), then paid standing.
 * Subscription read failures propagate so the gate fails closed.
 */
export async function canCreateSpace(user: IUserDocument): Promise<boolean> {
  if (!user.emailVerified) return false;
  if (user.isAdmin || hasDeveloperUserTag(user.tags)) return true;

  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { skipCache: true, names: ['SpaceCreationRequiresPaidStanding'] }
  );
  if (getSettingsValue('SpaceCreationRequiresPaidStanding', settings) !== true) return true;

  const subscriptions = await getActiveSubscriptionsForUser(user.id, { strict: true });
  return holdsPaidStanding(user, subscriptions);
}
