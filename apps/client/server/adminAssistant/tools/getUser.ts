import { organizationRepository } from '@bike4mind/database';
import { userApiKeyService } from '@bike4mind/services';
import { toEntitlementUser, getUserEntitlements } from '../../entitlements';
import { getActiveSubscriptionsForUser } from '../../entitlements/activeSubscriptions';
import { SubscriptionOwnerType, resolveSubscriptionSource } from '@bike4mind/server-utils/lib/subscriptions/types';
import { defineAdminTool } from '../defineAdminTool';
import { ADMIN_ASSISTANT_USER_FIELDS, resolveAdminUserRef } from '../resolveAdminUserRef';
import { AdminUserRefSchema } from '../schemas';

const MAX_ORGANIZATIONS = 20;

type OrgRole = 'owner' | 'admin' | 'member';

const toIso = (value: Date | string | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null;

export const getUserTool = defineAdminTool({
  name: 'admin_get_user',
  description:
    'Look up one user by id or email: profile basics, organizations (with role), active subscriptions, entitlement keys and API key trust standing.',
  input: AdminUserRefSchema,
  run: async ref => {
    const user = await resolveAdminUserRef(ref);
    if (!user) return { ok: false, error: 'not_found', message: 'No user matches that id or email.' };

    const [orgs, subscriptions] = await Promise.all([
      organizationRepository.search(
        '',
        { userId: user.id },
        { page: 1, limit: MAX_ORGANIZATIONS },
        { field: 'name', direction: 'asc' }
      ),
      getActiveSubscriptionsForUser(user.id),
    ]);
    const entitlementKeys = await getUserEntitlements(toEntitlementUser(user), subscriptions);
    const hasPaidStanding = await userApiKeyService.hasPaidStanding(user, async () => subscriptions.length > 0);

    const picked: Record<string, unknown> = {};
    for (const field of ADMIN_ASSISTANT_USER_FIELDS) {
      const value: unknown = field === 'id' ? user.id : user[field];
      picked[field] = value instanceof Date ? value.toISOString() : (value ?? null);
    }
    picked.organizationId = user.organizationId ? String(user.organizationId) : null;

    return {
      ok: true,
      data: {
        user: picked,
        organizations: orgs.data.slice(0, MAX_ORGANIZATIONS).map(org => ({
          id: org.id,
          name: org.name,
          role: (org.userId === user.id
            ? 'owner'
            : org.adminUserIds?.includes(user.id)
              ? 'admin'
              : 'member') as OrgRole,
        })),
        subscriptions: subscriptions.map(subscription => ({
          plan: subscription.priceId,
          status: subscription.status,
          source: resolveSubscriptionSource(subscription),
          periodEndsAt: toIso(subscription.periodEndsAt),
          owner: subscription.ownerType === SubscriptionOwnerType.Organization ? 'organization' : 'user',
        })),
        entitlementKeys,
        apiKeyTrust: { approved: user.apiKeyTrustApproved === true, hasPaidStanding },
      },
    };
  },
});
