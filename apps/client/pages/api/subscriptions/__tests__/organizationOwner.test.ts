import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { NotFoundError } from '@bike4mind/utils';
import { SubscriptionOwnerType } from '@client/lib/subscriptions/types';

/**
 * GET /api/subscriptions/Organization/:ownerId previously resolved the caller-supplied ownerId
 * with a bare organizationRepository.findById, handing any authenticated caller any
 * organization's active subscriptions. It now resolves through verifyOrgMembership, which answers
 * NotFoundError identically for a missing org and one the caller does not belong to.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const verifyOrgMembership = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/orgAccess', () => ({ verifyOrgMembership }));

// A regression to the bare repository lookup would make the gate assertions below silently
// vacuous - the mocked gate simply would not be reached - so the old path is mocked to throw.
const repositoryFindById = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('organizationRepository.findById must not gate this route; use verifyOrgMembership');
  })
);
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: { findById: repositoryFindById } }));

const findActiveSubscriptionsByOwner = vi.hoisted(() => vi.fn());
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: { findActiveSubscriptionsByOwner },
}));

import '@pages/api/subscriptions/[ownerType]/[ownerId]/index';

function mocks(user: unknown, query: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'GET', query });
  (req as any).user = user;
  return { req, res };
}

describe('GET /api/subscriptions/Organization/:ownerId - verifyOrgMembership gate', () => {
  beforeEach(() => {
    verifyOrgMembership.mockReset();
    findActiveSubscriptionsByOwner.mockReset();
  });

  it('resolves the organization through verifyOrgMembership, not a bare repository lookup', async () => {
    verifyOrgMembership.mockResolvedValueOnce({ id: 'org1' });
    findActiveSubscriptionsByOwner.mockResolvedValueOnce([]);

    const { req, res } = mocks({ id: 'u1' }, { ownerType: SubscriptionOwnerType.Organization, ownerId: 'org1' });
    await mockRefs.getHandler!(req, res);

    expect(verifyOrgMembership).toHaveBeenCalledTimes(1);
    expect(repositoryFindById).not.toHaveBeenCalled();
  });

  it('calls verifyOrgMembership with the caller-supplied ownerId', async () => {
    verifyOrgMembership.mockResolvedValueOnce({ id: 'org1' });
    findActiveSubscriptionsByOwner.mockResolvedValueOnce([]);

    const { req, res } = mocks({ id: 'u1' }, { ownerType: SubscriptionOwnerType.Organization, ownerId: 'org1' });
    await mockRefs.getHandler!(req, res);

    expect(verifyOrgMembership).toHaveBeenCalledWith(req.user, 'org1');
  });

  it('never looks up subscriptions when verifyOrgMembership rejects', async () => {
    verifyOrgMembership.mockRejectedValueOnce(new NotFoundError('Organization not found'));

    const { req, res } = mocks({ id: 'u1' }, { ownerType: SubscriptionOwnerType.Organization, ownerId: 'org1' });
    await expect(mockRefs.getHandler!(req, res)).rejects.toBeInstanceOf(NotFoundError);

    expect(findActiveSubscriptionsByOwner).not.toHaveBeenCalled();
  });

  it('returns the subscriptions for that owner on success', async () => {
    verifyOrgMembership.mockResolvedValueOnce({ id: 'org1' });
    const subscriptions = [{ ownerType: SubscriptionOwnerType.Organization, ownerId: 'org1', status: 'active' }];
    findActiveSubscriptionsByOwner.mockResolvedValueOnce(subscriptions);

    const { req, res } = mocks({ id: 'u1' }, { ownerType: SubscriptionOwnerType.Organization, ownerId: 'org1' });
    await mockRefs.getHandler!(req, res);

    expect(findActiveSubscriptionsByOwner).toHaveBeenCalledWith(SubscriptionOwnerType.Organization, 'org1');
    expect(res._getJSONData()).toEqual(subscriptions);
  });
});
