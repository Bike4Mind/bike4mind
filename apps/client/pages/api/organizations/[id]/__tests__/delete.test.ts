import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * DELETE /api/organizations/[id] (org-groups #1172/#1219). Pins two things that were both
 * absent before this PR: the group/user adapters actually reach `deleteOrganization` (so the
 * member purge + group soft-delete happen), and the whole write is wrapped in `withTransaction`
 * so a partial failure can't leave dangling group access or an org that never deletes.
 */

const mockRefs = vi.hoisted(() => ({
  deleteHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: () => chain,
    put: () => chain,
    delete: (fn: any) => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const deleteOrganization = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@bike4mind/services', () => ({ organizationService: { deleteOrganization } }));

const organizationRepository = vi.hoisted(() => ({}));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository }));

const groupRepository = vi.hoisted(() => ({}));
vi.mock('@bike4mind/database/social', () => ({ groupRepository }));

const updateMany = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const withTransaction = vi.hoisted(() => vi.fn((fn: any) => fn()));
vi.mock('@bike4mind/database', () => ({
  userRepository: {},
  partnerSignupRuleRepository: { updateMany },
  withTransaction,
}));

const invalidatePartnerRuleCache = vi.hoisted(() => vi.fn());
vi.mock('@server/entitlements/partnerRules', () => ({ invalidatePartnerRuleCache }));

const findActiveSubscriptionsByOwner = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: { findActiveSubscriptionsByOwner },
}));
vi.mock('@client/lib/subscriptions/types', () => ({ SubscriptionOwnerType: { Organization: 'organization' } }));

import '@pages/api/organizations/[id]/index';

describe('DELETE /api/organizations/[id]', () => {
  beforeEach(() => {
    deleteOrganization.mockClear();
    updateMany.mockClear();
    invalidatePartnerRuleCache.mockClear();
    withTransaction.mockClear();
    findActiveSubscriptionsByOwner.mockClear().mockResolvedValue([]);
  });

  const call = () => {
    const { req, res } = createMocks({ method: 'DELETE', query: { id: 'org1' } });
    (req as any).user = { id: 'admin1', isAdmin: true };
    return mockRefs.deleteHandler!(req, res);
  };

  it('wraps the delete in withTransaction', async () => {
    await call();
    expect(withTransaction).toHaveBeenCalledTimes(1);
  });

  it('passes the group and user adapters through to deleteOrganization', async () => {
    await call();

    expect(deleteOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'admin1' }),
      { id: 'org1' },
      expect.objectContaining({
        db: expect.objectContaining({
          organizations: organizationRepository,
          groups: groupRepository,
          users: {},
        }),
      })
    );
  });

  it('clears the dangling partner-rule reference and invalidates the cache after deleting', async () => {
    await call();

    expect(updateMany).toHaveBeenCalledWith({ organizationId: 'org1' }, { organizationId: null });
    expect(invalidatePartnerRuleCache).toHaveBeenCalledTimes(1);
  });

  it('does not clear the partner-rule reference if deleteOrganization throws', async () => {
    deleteOrganization.mockRejectedValueOnce(new Error('blocked'));

    await expect(call()).rejects.toThrow('blocked');
    expect(updateMany).not.toHaveBeenCalled();
    expect(invalidatePartnerRuleCache).not.toHaveBeenCalled();
  });

  it('still runs the active-subscriptions validation via canDeleteOrganization', async () => {
    await call();

    // The route's canDeleteOrganization closure is passed to the service, not invoked directly
    // here (deleteOrganization is mocked) - invoke it manually to prove the closure is wired.
    const passedAdapters = deleteOrganization.mock.calls[0][2];
    await passedAdapters.validation.canDeleteOrganization({ id: 'org1' });

    expect(findActiveSubscriptionsByOwner).toHaveBeenCalledWith('organization', 'org1');
  });
});
