import { describe, expect, it, vi } from 'vitest';
import { CreditHolderType } from '@bike4mind/common';
import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';
import { SUBSCRIPTION_PLANS, TEAM_PLAN } from '@client/lib/userSubscriptions/constants';
import type { ResolveScopeDeps, ScopeKey } from './resolveScope';
import { defaultPaidScopeDeps, resolvePaidScopes, type PaidScopeDeps } from './paidScopes';

const queryMocks = vi.hoisted(() => ({ find: vi.fn(), select: vi.fn(), lean: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ Organization: { find: queryMocks.find } }));
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({
  subscriptionRepository: { findActiveSubscriptionsByOwners: vi.fn() },
}));

function createDeps() {
  const scopeDeps: ResolveScopeDeps = {
    findUsersByIds: async ids => ids.map(id => ({ id, email: null })),
    findOrganizationsByIds: async ids => ids.map(id => ({ id, name: id })),
    findApiKeysByIds: async () => [],
    findAgentsByIds: async () => [],
  };
  const paidDeps = {
    findActiveSubscriptionsByOwners: vi.fn<PaidScopeDeps['findActiveSubscriptionsByOwners']>(async () => []),
    findPlanHolderOrganizations: vi.fn<PaidScopeDeps['findPlanHolderOrganizations']>(async () => []),
  };
  return { scopeDeps, paidDeps };
}

const userKey = (scopeId: string): ScopeKey => ({ scopeType: 'User', scopeId });
const subscription = (ownerId: string, priceId = SUBSCRIPTION_PLANS[0].priceId, status = 'active') => ({
  ownerId,
  priceId,
  status,
});

describe('resolvePaidScopes', () => {
  it('does no reads for an empty candidate set', async () => {
    const { scopeDeps, paidDeps } = createDeps();
    expect(await resolvePaidScopes([], scopeDeps, paidDeps)).toEqual(new Set());
    expect(paidDeps.findPlanHolderOrganizations).not.toHaveBeenCalled();
    expect(paidDeps.findActiveSubscriptionsByOwners).not.toHaveBeenCalled();
  });

  it('requires an active recognized paid plan, regardless of subscription source or period dates', async () => {
    const { scopeDeps, paidDeps } = createDeps();
    const ids = ['paid', 'grant', 'unknown', 'canceled', 'trial', 'past-due', 'free', 'buyer-only'];
    const scheduledCancellation = {
      ...subscription('paid'),
      periodEndsAt: new Date('2000-01-01'),
      cancelAtPeriodEnd: true,
    };
    const grant = { ...subscription('grant'), source: 'admin_grant' };
    paidDeps.findActiveSubscriptionsByOwners.mockResolvedValue([
      scheduledCancellation,
      grant,
      subscription('unknown', 'price_unknown'),
      subscription('canceled', SUBSCRIPTION_PLANS[0].priceId, 'canceled'),
      subscription('trial', SUBSCRIPTION_PLANS[0].priceId, 'trialing'),
      subscription('past-due', SUBSCRIPTION_PLANS[0].priceId, 'past_due'),
    ]);
    expect(await resolvePaidScopes(ids.map(userKey), scopeDeps, paidDeps)).toEqual(
      new Set(['User:paid', 'User:grant'])
    );
    expect(paidDeps.findActiveSubscriptionsByOwners).toHaveBeenCalledExactlyOnceWith(SubscriptionOwnerType.User, ids);
  });

  it('inherits the actual payer tier for keys and agents without transferring a creator plan to an org', async () => {
    const { scopeDeps, paidDeps } = createDeps();
    scopeDeps.findApiKeysByIds = async () => [
      { id: 'personal', name: 'Personal', userId: 'paid' },
      {
        id: 'org-free',
        name: 'Org free',
        userId: 'paid',
        organizationId: 'free-org',
        billingOwnerType: CreditHolderType.Organization,
      },
      {
        id: 'org-paid',
        name: 'Org paid',
        userId: 'free',
        organizationId: 'paid-org',
        billingOwnerType: CreditHolderType.Organization,
      },
    ];
    scopeDeps.findAgentsByIds = async () => [
      { id: 'personal-agent', name: 'Personal agent', userId: 'paid', organizationId: 'free-org' },
      { id: 'org-agent', name: 'Org agent', organizationId: 'paid-org' },
    ];
    paidDeps.findActiveSubscriptionsByOwners.mockImplementation(async ownerType =>
      ownerType === SubscriptionOwnerType.User ? [subscription('paid')] : [subscription('paid-org', TEAM_PLAN.priceId)]
    );
    const keys: ScopeKey[] = [
      ...['personal', 'org-free', 'org-paid', 'missing-key'].map(scopeId => ({
        scopeType: 'apiKey' as const,
        scopeId,
      })),
      ...['personal-agent', 'org-agent', 'missing-agent'].map(scopeId => ({ scopeType: 'Agent' as const, scopeId })),
      { scopeType: 'Organization', scopeId: 'paid-org' },
    ];
    expect(await resolvePaidScopes(keys, scopeDeps, paidDeps)).toEqual(
      new Set([
        'apiKey:personal',
        'apiKey:org-paid',
        'Agent:personal-agent',
        'Agent:org-agent',
        'Organization:paid-org',
      ])
    );
    expect(paidDeps.findActiveSubscriptionsByOwners).toHaveBeenCalledTimes(2);
  });

  it('grants org plans to owners, managers, and read/write seat holders only', async () => {
    const { scopeDeps, paidDeps } = createDeps();
    paidDeps.findPlanHolderOrganizations.mockResolvedValue([
      {
        id: 'team',
        userId: 'owner',
        adminUserIds: ['manager'],
        users: [
          { userId: 'reader', permissions: ['read'] },
          { userId: 'writer', permissions: ['write'] },
          { userId: 'no-seat', permissions: [] },
          { userId: 'no-permissions' },
        ],
      },
      { id: 'free-team', userId: 'free-owner', users: [{ userId: 'free-member', permissions: ['read'] }] },
    ]);
    paidDeps.findActiveSubscriptionsByOwners.mockImplementation(async ownerType =>
      ownerType === SubscriptionOwnerType.Organization ? [subscription('team', TEAM_PLAN.priceId)] : []
    );
    const ids = [
      'owner',
      'manager',
      'reader',
      'writer',
      'no-seat',
      'no-permissions',
      'free-owner',
      'free-member',
      'pointer-only',
    ];
    expect(await resolvePaidScopes(ids.map(userKey), scopeDeps, paidDeps)).toEqual(
      new Set(['User:owner', 'User:manager', 'User:reader', 'User:writer'])
    );
    expect(paidDeps.findPlanHolderOrganizations).toHaveBeenCalledExactlyOnceWith(ids);
    expect(paidDeps.findActiveSubscriptionsByOwners).toHaveBeenCalledWith(SubscriptionOwnerType.Organization, [
      'team',
      'free-team',
    ]);
  });

  it.each(['memberships', 'subscriptions'])('propagates %s lookup failures', async lookup => {
    const { scopeDeps, paidDeps } = createDeps();
    const error = new Error('database unavailable');
    if (lookup === 'memberships') paidDeps.findPlanHolderOrganizations.mockRejectedValue(error);
    else paidDeps.findActiveSubscriptionsByOwners.mockRejectedValue(error);
    await expect(resolvePaidScopes([userKey('paid')], scopeDeps, paidDeps)).rejects.toBe(error);
  });
});

describe('defaultPaidScopeDeps', () => {
  it('queries owner, read/write member, and manager plan holders in one projected read', async () => {
    queryMocks.find.mockReturnValue({ select: queryMocks.select });
    queryMocks.select.mockReturnValue({ lean: queryMocks.lean });
    queryMocks.lean.mockResolvedValue([{ _id: 'team', userId: 'owner', users: [] }]);
    expect(await defaultPaidScopeDeps().findPlanHolderOrganizations(['owner', 'member'])).toEqual([
      { _id: 'team', id: 'team', userId: 'owner', users: [] },
    ]);
    expect(queryMocks.find).toHaveBeenCalledExactlyOnceWith({
      $or: [
        { userId: { $in: ['owner', 'member'] } },
        { users: { $elemMatch: { userId: { $in: ['owner', 'member'] }, permissions: { $in: ['read', 'write'] } } } },
        { adminUserIds: { $in: ['owner', 'member'] } },
      ],
    });
    expect(queryMocks.select).toHaveBeenCalledWith('userId users.userId users.permissions adminUserIds');
    expect(queryMocks.lean).toHaveBeenCalledOnce();
  });
});
