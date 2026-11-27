import { describe, expect, it, vi } from 'vitest';
import { SUBSCRIPTION_PLANS } from '@bike4mind/server-utils/lib/userSubscriptions/constants';
import { resolveTopAccountContexts, type ResolveTopAccountContextDeps } from './topAccountContext';

vi.mock('@bike4mind/database', () => ({ Organization: {}, User: {} }));
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({
  subscriptionRepository: { findActiveSubscriptionsByOwners: vi.fn() },
}));

const WINDOW = { start: new Date('2026-10-30T10:00:00Z'), end: new Date('2026-10-30T10:15:00Z') };
const NEW_USER = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const PAID_USER = 'cccccccccccccccccccccccc';
const ORG = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const STRIPE_ONLY_ORG = 'dddddddddddddddddddddddd';

function createDeps(): ResolveTopAccountContextDeps {
  return {
    topAccountContextDeps: {
      findUsers: vi.fn(async () => [
        { id: NEW_USER, createdAt: new Date('2026-10-30T10:02:00Z'), currentCredits: 1000 },
        { id: PAID_USER, createdAt: new Date('2023-01-01'), currentCredits: 50_000, stripeCustomerId: 'cus_fake' },
      ]),
      findOrganizations: vi.fn(async () => [
        {
          id: ORG,
          createdAt: new Date('2025-09-01'),
          currentCredits: 2_500_000,
          stripeCustomerId: 'cus_fake_org',
          lastCreditsPurchasedAt: new Date('2025-09-02'),
        },
        { id: STRIPE_ONLY_ORG, createdAt: null, currentCredits: null, stripeCustomerId: 'cus_fake_2' },
      ]),
    },
    rollups: {
      ownerModelActivity: vi.fn(async () => [
        { scopeType: 'Organization' as const, scopeId: ORG, model: 'flux-3-video', credits: 3700, calls: 42 },
        { scopeType: 'Organization' as const, scopeId: ORG, model: 'small-model', credits: 12, calls: 90 },
        { scopeType: 'User' as const, scopeId: NEW_USER, model: 'opus-x', credits: 2400, calls: 3 },
      ]),
    },
    resolveScopeDeps: {
      findUsersByIds: vi.fn(async () => []),
      findOrganizationsByIds: vi.fn(async () => []),
      findApiKeysByIds: vi.fn(async () => []),
      findAgentsByIds: vi.fn(async () => []),
    },
    paidScopeDeps: {
      findActiveSubscriptionsByOwners: vi.fn(async (_ownerType, ownerIds) =>
        ownerIds.includes(PAID_USER)
          ? [{ ownerId: PAID_USER, priceId: SUBSCRIPTION_PLANS[0].priceId, status: 'active' }]
          : []
      ),
      findPlanHolderOrganizations: vi.fn(async () => []),
    },
  };
}

const keys = [
  { scopeType: 'User' as const, scopeId: NEW_USER },
  { scopeType: 'User' as const, scopeId: PAID_USER },
  { scopeType: 'Organization' as const, scopeId: ORG },
  { scopeType: 'Organization' as const, scopeId: STRIPE_ONLY_ORG },
  { scopeType: 'User' as const, scopeId: 'eeeeeeeeeeeeeeeeeeeeeeee' },
];

describe('resolveTopAccountContexts', () => {
  it('derives kind, age, balance, funding, top model and admin path for each found account', async () => {
    const contexts = await resolveTopAccountContexts(keys, WINDOW, createDeps());

    expect(contexts.get(`User:${NEW_USER}`)).toEqual({
      kind: 'user',
      adminPath: `/admin/users/${NEW_USER}`,
      ageMs: 13 * 60_000,
      creditBalance: 1000,
      funding: 'granted',
      topModel: { model: 'opus-x', calls: 3 },
    });
    expect(contexts.get(`User:${PAID_USER}`)).toMatchObject({ funding: 'subscription', topModel: null });
    expect(contexts.get(`Organization:${ORG}`)).toMatchObject({
      kind: 'org',
      adminPath: `/admin?tab=organizations&orgId=${ORG}`,
      funding: 'purchase',
      // Largest by credits, not by call count.
      topModel: { model: 'flux-3-video', calls: 42 },
    });
    expect(contexts.get(`Organization:${STRIPE_ONLY_ORG}`)).toMatchObject({
      funding: 'stripe_customer',
      ageMs: null,
      creditBalance: null,
    });
    // A deleted account has no record and so no context.
    expect(contexts.has('User:eeeeeeeeeeeeeeeeeeeeeeee')).toBe(false);
  });

  it('reads each source once for all accounts', async () => {
    const deps = createDeps();
    await resolveTopAccountContexts(keys, WINDOW, deps);
    expect(deps.topAccountContextDeps.findUsers).toHaveBeenCalledTimes(1);
    expect(deps.topAccountContextDeps.findOrganizations).toHaveBeenCalledTimes(1);
    expect(deps.rollups.ownerModelActivity).toHaveBeenCalledTimes(1);
  });

  it('propagates a failed read so the caller can fall back', async () => {
    const deps = createDeps();
    vi.mocked(deps.topAccountContextDeps.findOrganizations).mockRejectedValue(new Error('mongo down'));
    await expect(resolveTopAccountContexts(keys, WINDOW, deps)).rejects.toThrow('mongo down');
  });

  it('reads nothing for an empty key list', async () => {
    const deps = createDeps();
    await expect(resolveTopAccountContexts([], WINDOW, deps)).resolves.toEqual(new Map());
    expect(deps.rollups.ownerModelActivity).not.toHaveBeenCalled();
  });
});
