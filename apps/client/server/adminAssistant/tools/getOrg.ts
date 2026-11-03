import { organizationStorageLimitBytes, type IOrganizationDocument } from '@bike4mind/common';
import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';
import { subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';
import { resolveUserNames } from '../../utils/resolveUserNames';
import { defineAdminTool } from '../defineAdminTool';
import { orgRoleOf, toSubscriptionSummary } from '../formatters';
import { resolveAdminOrgRef } from '../resolveAdminOrgRef';
import { AdminOrgRefSchema } from '../schemas';

const MAX_MEMBERS = 25;
// Same cap as admin_get_user_feedback puts on customer-written text.
const MAX_DESCRIPTION_CHARS = 500;

/**
 * The only organization fields the admin assistant may emit; output is always built by picking
 * these, never by spreading a doc. Excludes ORGANIZATION_SECRET_FIELDS (toSafeOrganization) and
 * the customer-written systemPrompt, which is reported only as present or not.
 */
export const ADMIN_ASSISTANT_ORG_FIELDS = [
  'id',
  'name',
  'personal',
  'description',
  'billingContact',
  'seats',
  'currentCredits',
  'lastCreditsPurchasedAt',
  'maxCreditsPerMember',
  'currentStorageSize',
  'allowedGroupTypes',
  'createdAt',
] as const;

const toOrgFieldValue = (org: IOrganizationDocument, field: (typeof ADMIN_ASSISTANT_ORG_FIELDS)[number]): unknown => {
  const value: unknown = org[field];
  if (field === 'description' && typeof value === 'string') return value.slice(0, MAX_DESCRIPTION_CHARS);
  return value instanceof Date ? value.toISOString() : (value ?? null);
};

export const getOrgTool = defineAdminTool({
  name: 'admin_get_org',
  description:
    'Look up one organization by id or name: profile basics (description truncated to 500 characters, seats, credit balance, storage used against its effective limit, both in bytes), owner, members with role, and active subscriptions. The owner is reported separately and is usually not in the members list; memberCount includes the owner, matching how seats are counted.',
  input: AdminOrgRefSchema,
  run: async ref => {
    const resolved = await resolveAdminOrgRef(ref);
    if (!resolved.ok) return resolved;
    const { org } = resolved;

    const members = org.users ?? [];
    const shownMembers = members.slice(0, MAX_MEMBERS);
    const [names, subscriptions] = await Promise.all([
      resolveUserNames([org.userId, ...shownMembers.map(member => member.userId)]),
      subscriptionRepository.findActiveSubscriptionsByOwners(SubscriptionOwnerType.Organization, [org.id]),
    ]);

    return {
      ok: true,
      data: {
        organization: {
          ...Object.fromEntries(ADMIN_ASSISTANT_ORG_FIELDS.map(field => [field, toOrgFieldValue(org, field)])),
          storageLimitBytes: organizationStorageLimitBytes(org),
          hasSystemPrompt: Boolean(org.systemPrompt?.trim()),
        },
        owner: { userId: org.userId, name: names.get(org.userId) ?? null },
        memberCount: members.length + (members.some(member => member.userId === org.userId) ? 0 : 1),
        members: shownMembers.map(member => ({
          userId: member.userId,
          name: names.get(member.userId) ?? null,
          role: orgRoleOf(org, member.userId),
        })),
        membersTruncated: members.length > MAX_MEMBERS,
        subscriptions: subscriptions.map(subscription => ({
          ...toSubscriptionSummary(subscription),
          seats: subscription.quantity,
        })),
      },
    };
  },
});
