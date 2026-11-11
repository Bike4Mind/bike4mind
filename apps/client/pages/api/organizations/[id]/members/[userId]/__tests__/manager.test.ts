import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * PUT/DELETE /api/organizations/[id]/members/[userId]/manager. Authorization and membership live in
 * organizationService.setOrganizationManager (setOrganizationManager.test.ts); this pins the route's
 * own contract: the API-key scope gate, the service wiring, the audit and the serialized response.
 */

type Handler = (req: unknown, res: unknown) => unknown;
const mockRefs = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  baseApiOptions: undefined as unknown,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, (fn: Handler) => unknown> = {};
  for (const method of ['put', 'delete']) {
    chain[method] = (fn: Handler) => {
      mockRefs.handlers[method] = fn;
      return chain;
    };
  }
  return {
    baseApi: (options: unknown) => {
      mockRefs.baseApiOptions = options;
      return chain;
    },
  };
});

const setOrganizationManager = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services', () => ({ organizationService: { setOrganizationManager } }));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: { marker: 'orgRepo' } }));
const recordAdminActionFromRequest = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest }));

import '@pages/api/organizations/[id]/members/[userId]/manager';

const call = (method: 'PUT' | 'DELETE', query: Record<string, string> = { id: 'org1', userId: 'member1' }) => {
  const { req, res } = createMocks({ method, query });
  Object.assign(req, { user: { id: 'owner1', isAdmin: false } });
  return { res, run: () => mockRefs.handlers[method.toLowerCase()](req, res) };
};

describe('/api/organizations/[id]/members/[userId]/manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setOrganizationManager.mockResolvedValue({
      organization: { id: 'org1', name: 'Acme', userId: 'owner1', stripeCustomerId: 'cus_secret' },
      previousAdminUserIds: ['a'],
      adminUserIds: ['a', 'member1'],
      changed: true,
    });
  });

  it('is first-party only (jwtOnly)', () => {
    expect(mockRefs.baseApiOptions).toEqual({ auth: 'jwtOnly' });
  });

  it('PUT appoints, audits org.admins.updated with both lists, and returns the safe org', async () => {
    const { res, run } = call('PUT');
    await run();

    expect(setOrganizationManager).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'owner1' }),
      { organizationId: 'org1', userId: 'member1', isManager: true },
      { db: { organizations: { marker: 'orgRepo' } } }
    );
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'org.admins.updated',
        actorScope: 'organization',
        target: { kind: 'organization', id: 'org1', displayName: 'Acme' },
        changes: [{ field: 'adminUserIds', before: ['a'], after: ['a', 'member1'] }],
        details: { memberUserId: 'member1' },
      })
    );
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).not.toHaveProperty('stripeCustomerId');
  });

  it('DELETE removes the manager', async () => {
    const { run } = call('DELETE');
    await run();

    expect(setOrganizationManager).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: 'org1', userId: 'member1', isManager: false },
      expect.anything()
    );
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ summary: 'removed an organization manager' })
    );
  });

  it('does not audit a request that changed nothing', async () => {
    setOrganizationManager.mockResolvedValueOnce({
      organization: { id: 'org1', name: 'Acme', userId: 'owner1' },
      previousAdminUserIds: ['a'],
      adminUserIds: ['a'],
      changed: false,
    });
    const { res, run } = call('DELETE');
    await run();

    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
    expect(res._getStatusCode()).toBe(200);
  });

  it('does not audit when the service refuses', async () => {
    setOrganizationManager.mockRejectedValueOnce(new Error('Organization not found'));
    const { run } = call('PUT');
    // asyncHandler may rethrow or hand the error to the error middleware; either way nothing is audited.
    await Promise.resolve(run()).catch(() => undefined);

    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });
});
