import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { SubscriptionOwnerType } from '@client/lib/subscriptions/types';

/**
 * GET /api/subscriptions/Organization/:ownerId previously resolved the caller-supplied ownerId
 * with a bare organizationRepository.findById, handing any authenticated caller any
 * organization's active subscriptions. It now resolves through verifyOrgMemberOrManager, which
 * answers NotFoundError identically for a missing org and one the caller may not read.
 *
 * It also read active-only, so an org whose subscription went past_due got [] and lost the Stripe
 * portal. It now reads the non-terminal lookup; the assertions below pin that, because a revert to
 * the active-only predicate leaves every other suite (all of which mock the repository) green.
 */

type Handler = (req: unknown, res: unknown) => unknown;
const mockRefs = vi.hoisted(() => ({ getHandler: null as Handler | null }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    get: (fn: Handler) => {
      mockRefs.getHandler = fn;
      return fn;
    },
  };
  return { baseApi: () => chain };
});

const verifyOrgMemberOrManager = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/orgAccess', () => ({ verifyOrgMemberOrManager }));

// A regression to the bare repository lookup would make the gate assertions below silently
// vacuous - the mocked gate simply would not be reached - so the old path is mocked to throw.
const repositoryFindById = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('organizationRepository.findById must not gate this route; use the scoped access helpers');
  })
);
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: { findById: repositoryFindById } }));

const findNonTerminalSubscriptionsByOwner = vi.hoisted(() => vi.fn());
const findActiveSubscriptionsByOwner = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('the org route must read non-terminal rows; the active-only predicate hides past_due');
  })
);
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: { findNonTerminalSubscriptionsByOwner, findActiveSubscriptionsByOwner },
}));

import '@pages/api/subscriptions/[ownerType]/[ownerId]/index';

function mocks(user: unknown, query: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'GET', query });
  (req as unknown as { user: unknown }).user = user;
  return { req, res };
}

describe('GET /api/subscriptions/Organization/:ownerId - member and manager gate', () => {
  beforeEach(() => {
    verifyOrgMemberOrManager.mockReset();
    findNonTerminalSubscriptionsByOwner.mockReset();
    findActiveSubscriptionsByOwner.mockClear();
  });

  it('resolves the organization through verifyOrgMemberOrManager, not a bare repository lookup', async () => {
    verifyOrgMemberOrManager.mockResolvedValueOnce({ id: 'org1' });
    findNonTerminalSubscriptionsByOwner.mockResolvedValueOnce([]);

    const { req, res } = mocks({ id: 'u1' }, { ownerType: SubscriptionOwnerType.Organization, ownerId: 'org1' });
    await mockRefs.getHandler!(req, res);

    expect(verifyOrgMemberOrManager).toHaveBeenCalledTimes(1);
    expect(repositoryFindById).not.toHaveBeenCalled();
  });

  it('calls the gate with the caller-supplied ownerId', async () => {
    verifyOrgMemberOrManager.mockResolvedValueOnce({ id: 'org1' });
    findNonTerminalSubscriptionsByOwner.mockResolvedValueOnce([]);

    const { req, res } = mocks({ id: 'u1' }, { ownerType: SubscriptionOwnerType.Organization, ownerId: 'org1' });
    await mockRefs.getHandler!(req, res);

    expect(verifyOrgMemberOrManager).toHaveBeenCalledWith(req.user, 'org1');
  });

  it('never looks up subscriptions when the gate rejects', async () => {
    verifyOrgMemberOrManager.mockRejectedValueOnce(new NotFoundError('Organization not found'));

    const { req, res } = mocks({ id: 'u1' }, { ownerType: SubscriptionOwnerType.Organization, ownerId: 'org1' });
    await expect(mockRefs.getHandler!(req, res)).rejects.toBeInstanceOf(NotFoundError);

    expect(findNonTerminalSubscriptionsByOwner).not.toHaveBeenCalled();
  });

  it('preserves invalid organization ID errors', async () => {
    verifyOrgMemberOrManager.mockRejectedValueOnce(new BadRequestError('Invalid organization ID'));

    const { req, res } = mocks({ id: 'u1' }, { ownerType: SubscriptionOwnerType.Organization, ownerId: 'invalid' });
    await expect(mockRefs.getHandler!(req, res)).rejects.toBeInstanceOf(BadRequestError);

    expect(findNonTerminalSubscriptionsByOwner).not.toHaveBeenCalled();
  });

  it('returns the subscriptions for that owner on success', async () => {
    verifyOrgMemberOrManager.mockResolvedValueOnce({ id: 'org1' });
    const subscriptions = [{ ownerType: SubscriptionOwnerType.Organization, ownerId: 'org1', status: 'active' }];
    findNonTerminalSubscriptionsByOwner.mockResolvedValueOnce(subscriptions);

    const { req, res } = mocks({ id: 'u1' }, { ownerType: SubscriptionOwnerType.Organization, ownerId: 'org1' });
    await mockRefs.getHandler!(req, res);

    expect(findNonTerminalSubscriptionsByOwner).toHaveBeenCalledWith(SubscriptionOwnerType.Organization, 'org1');
    expect(res._getJSONData()).toEqual(subscriptions);
  });

  it('returns a delinquent row instead of hiding it, so the org keeps its billing portal', async () => {
    verifyOrgMemberOrManager.mockResolvedValueOnce({ id: 'org1' });
    const delinquent = [{ ownerType: SubscriptionOwnerType.Organization, ownerId: 'org1', status: 'past_due' }];
    findNonTerminalSubscriptionsByOwner.mockResolvedValueOnce(delinquent);

    const { req, res } = mocks({ id: 'u1' }, { ownerType: SubscriptionOwnerType.Organization, ownerId: 'org1' });
    await mockRefs.getHandler!(req, res);

    expect(res._getJSONData()).toEqual(delinquent);
    expect(findActiveSubscriptionsByOwner).not.toHaveBeenCalled();
  });
});
