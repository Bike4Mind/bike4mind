import type { IUserDocument } from '@bike4mind/common';
import { organizationRepository } from '@bike4mind/database';
import { userApiKeyService } from '@bike4mind/services';
import { toEntitlementUser, getUserEntitlements } from '../../entitlements';
import { getActiveSubscriptionsForUser } from '../../entitlements/activeSubscriptions';
import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';
import { defineAdminTool } from '../defineAdminTool';
import { orgRoleOf, toSubscriptionSummary } from '../formatters';
import { resolveAdminUserRef } from '../resolveAdminUserRef';
import { AdminUserRefSchema } from '../schemas';

const MAX_ORGANIZATIONS = 20;

/**
 * The only user fields the admin assistant may emit. Mirrors the non-secret subset of
 * ADMIN_USER_LIST_FIELDS (apps/client/app/utils/adminUserProjection.ts); `lastActiveAt` is the
 * schema's last-seen timestamp. Output is always built by picking these, never by spreading a doc.
 */
export const ADMIN_ASSISTANT_USER_FIELDS = [
  'id',
  'name',
  'username',
  'email',
  'createdAt',
  'lastActiveAt',
  'isAdmin',
  'emailVerified',
  'currentCredits',
  'apiKeyTrustApproved',
  'organizationId',
] as const;

const toUserFieldValue = (user: IUserDocument, field: (typeof ADMIN_ASSISTANT_USER_FIELDS)[number]): unknown => {
  if (field === 'id') return user.id;
  if (field === 'organizationId') return user.organizationId ? String(user.organizationId) : null;
  const value: unknown = user[field];
  return value instanceof Date ? value.toISOString() : (value ?? null);
};

export const getUserTool = defineAdminTool({
  name: 'admin_get_user',
  description:
    'Look up one user by id or email: profile basics, organizations (with role), active subscriptions, entitlement keys and API key trust standing.',
  input: AdminUserRefSchema,
  run: async ref => {
    const user = await resolveAdminUserRef(ref);
    if (!user) return { ok: false, error: 'not_found', message: 'No user matches that id or email.' };

    const [orgs, subscriptions] = await Promise.all([
      // search() has no projection option, so full org docs load; bounded by MAX_ORGANIZATIONS.
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

    const profile = Object.fromEntries(
      ADMIN_ASSISTANT_USER_FIELDS.map(field => [field, toUserFieldValue(user, field)])
    );

    return {
      ok: true,
      data: {
        user: profile,
        organizations: orgs.data.map(org => ({
          id: org.id,
          name: org.name,
          role: orgRoleOf(org, user.id),
        })),
        organizationsTruncated: orgs.hasMore,
        subscriptions: subscriptions.map(subscription => ({
          ...toSubscriptionSummary(subscription),
          owner: subscription.ownerType === SubscriptionOwnerType.Organization ? 'organization' : 'user',
        })),
        entitlementKeys,
        apiKeyTrust: { approved: user.apiKeyTrustApproved === true, hasPaidStanding },
      },
    };
  },
});
