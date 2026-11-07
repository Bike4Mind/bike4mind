import { CreditHolderType, ORG_MEMBERSHIP_ACL_PERMISSIONS, orgAclRowConfersMembership } from '@bike4mind/common';
import { Organization } from '@bike4mind/database';
import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';
import { subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';
import { hasPaidSubscription } from '@server/entitlements/paidStanding';
import { scopeMapKey, type ResolveScopeDeps, type ScopeKey } from './resolveScope';

type PlanHolderOrganization = {
  id: string;
  userId: string;
  adminUserIds?: readonly string[];
  users?: readonly { userId: string; permissions?: readonly string[] | null }[];
};

export type PaidScopeDeps = {
  findActiveSubscriptionsByOwners: (
    ownerType: SubscriptionOwnerType,
    ownerIds: readonly string[]
  ) => Promise<readonly { ownerId: string; priceId: string; status: string }[]>;
  findPlanHolderOrganizations: (userIds: readonly string[]) => Promise<readonly PlanHolderOrganization[]>;
};

const planHolderIds = (organization: PlanHolderOrganization): string[] => [
  organization.userId,
  ...(organization.adminUserIds ?? []),
  ...(organization.users ?? []).filter(orgAclRowConfersMembership).map(member => member.userId),
];

type Payer = { payerType: 'User' | 'Organization'; payerId: string };

async function scopePayers(keys: ScopeKey[], deps: ResolveScopeDeps): Promise<Map<string, Payer>> {
  const idsFor = (scopeType: ScopeKey['scopeType']): string[] => [
    ...new Set(keys.filter(key => key.scopeType === scopeType).map(key => key.scopeId)),
  ];
  const keyIds = idsFor('apiKey');
  const agentIds = idsFor('Agent');
  const [apiKeys, agents] = await Promise.all([
    keyIds.length > 0 ? deps.findApiKeysByIds(keyIds) : [],
    agentIds.length > 0 ? deps.findAgentsByIds(agentIds) : [],
  ]);
  const payers = new Map<string, Payer>();
  for (const key of keys) {
    if (key.scopeType === 'User' || key.scopeType === 'Organization') {
      payers.set(scopeMapKey(key.scopeType, key.scopeId), { payerType: key.scopeType, payerId: key.scopeId });
    }
  }
  for (const apiKey of apiKeys) {
    const payer: Payer =
      apiKey.billingOwnerType === CreditHolderType.Organization && apiKey.organizationId
        ? { payerType: 'Organization', payerId: apiKey.organizationId }
        : { payerType: 'User', payerId: apiKey.userId };
    payers.set(scopeMapKey('apiKey', apiKey.id), payer);
  }
  for (const agent of agents) {
    if (agent.userId) payers.set(scopeMapKey('Agent', agent.id), { payerType: 'User', payerId: agent.userId });
    else if (agent.organizationId)
      payers.set(scopeMapKey('Agent', agent.id), { payerType: 'Organization', payerId: agent.organizationId });
  }
  return payers;
}

/** Subscription tier follows the payer; org seats grant the same plan as the entitlement resolver. */
export async function resolvePaidScopes(
  keys: ScopeKey[],
  scopeDeps: ResolveScopeDeps,
  paidDeps: PaidScopeDeps
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const scopes = await scopePayers(keys, scopeDeps);
  const userIds = new Set<string>();
  const organizationIds = new Set<string>();
  for (const scope of scopes.values()) {
    if (!scope.payerId) continue;
    if (scope.payerType === 'User') userIds.add(scope.payerId);
    if (scope.payerType === 'Organization') organizationIds.add(scope.payerId);
  }
  const organizations = userIds.size > 0 ? await paidDeps.findPlanHolderOrganizations([...userIds]) : [];
  for (const organization of organizations) organizationIds.add(organization.id);
  const [userSubscriptions, organizationSubscriptions] = await Promise.all([
    userIds.size > 0 ? paidDeps.findActiveSubscriptionsByOwners(SubscriptionOwnerType.User, [...userIds]) : [],
    organizationIds.size > 0
      ? paidDeps.findActiveSubscriptionsByOwners(SubscriptionOwnerType.Organization, [...organizationIds])
      : [],
  ]);
  const paidOwners = (subscriptions: typeof userSubscriptions): Set<string> =>
    new Set(
      subscriptions
        .filter(subscription => subscription.status === 'active' && hasPaidSubscription([subscription]))
        .map(subscription => subscription.ownerId)
    );
  const paidUsers = paidOwners(userSubscriptions);
  const paidOrganizations = paidOwners(organizationSubscriptions);
  for (const organization of organizations) {
    if (!paidOrganizations.has(organization.id)) continue;
    for (const userId of planHolderIds(organization)) if (userIds.has(userId)) paidUsers.add(userId);
  }
  return new Set(
    [...scopes.entries()]
      .filter(([, scope]) =>
        scope.payerType === 'User' ? paidUsers.has(scope.payerId) : paidOrganizations.has(scope.payerId)
      )
      .map(([key]) => key)
  );
}

export function defaultPaidScopeDeps(): PaidScopeDeps {
  return {
    findActiveSubscriptionsByOwners: (ownerType, ownerIds) =>
      subscriptionRepository.findActiveSubscriptionsByOwners(ownerType, ownerIds),
    findPlanHolderOrganizations: async userIds => {
      if (userIds.length === 0) return [];
      // Same owner/member/admin arms as OrganizationRepository.findPlanHolderOrgIds, batched.
      const organizations = await Organization.find({
        $or: [
          { userId: { $in: [...userIds] } },
          {
            users: {
              $elemMatch: { userId: { $in: [...userIds] }, permissions: { $in: ORG_MEMBERSHIP_ACL_PERMISSIONS } },
            },
          },
          { adminUserIds: { $in: [...userIds] } },
        ],
      })
        .select('userId users.userId users.permissions adminUserIds')
        .lean<(Omit<PlanHolderOrganization, 'id'> & { _id: unknown })[]>();
      return organizations.map(organization => ({ ...organization, id: String(organization._id) }));
    },
  };
}
