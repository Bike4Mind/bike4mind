import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * PUT /api/organizations/[id]/members/[userId]/role. Authorization and membership live in
 * organizationService.setOrganizationMemberRole (setOrganizationMemberRole.test.ts); this pins the
 * route's own contract: the auth mode, body validation, the service wiring, the audit and the
 * serialized response.
 */

type Handler = (req: unknown, res: unknown) => unknown;
const mockRefs = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  baseApiOptions: undefined as unknown,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, (fn: Handler) => unknown> = {};
  for (const method of ['put']) {
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

const setOrganizationMemberRole = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services', () => ({ organizationService: { setOrganizationMemberRole } }));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: { marker: 'orgRepo' } }));
const transaction = vi.hoisted(() => ({ depth: 0 }));
vi.mock('@bike4mind/database', () => ({
  withTransaction: async <T>(fn: () => Promise<T>) => {
    transaction.depth += 1;
    try {
      return await fn();
    } finally {
      transaction.depth -= 1;
    }
  },
}));
const recordAdminActionFromRequest = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest }));

import '@pages/api/organizations/[id]/members/[userId]/role';

const call = (body: unknown) => {
  const { req, res } = createMocks({ method: 'PUT', query: { id: 'org1', userId: 'member1' }, body });
  Object.assign(req, { user: { id: 'owner1', isAdmin: false } });
  return { res, run: () => mockRefs.handlers.put(req, res) };
};

describe('/api/organizations/[id]/members/[userId]/role', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setOrganizationMemberRole.mockResolvedValue({
      organization: { id: 'org1', name: 'Acme', userId: 'owner1', stripeCustomerId: 'cus_secret' },
      previousRole: 'member',
      role: 'billingManager',
      changed: true,
    });
  });

  it('is first-party only (jwtOnly)', () => {
    expect(mockRefs.baseApiOptions).toEqual({ auth: 'jwtOnly' });
  });

  it('assigns the role, audits org.member.role_changed and returns the safe org', async () => {
    const { res, run } = call({ role: 'billingManager' });
    await run();

    expect(setOrganizationMemberRole).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'owner1' }),
      { organizationId: 'org1', userId: 'member1', role: 'billingManager' },
      { db: { organizations: { marker: 'orgRepo' } } }
    );
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'org.member.role_changed',
        actorScope: 'organization',
        target: { kind: 'organization', id: 'org1', displayName: 'Acme' },
        changes: [{ field: 'role', before: 'member', after: 'billingManager' }],
        details: { memberUserId: 'member1', organizationName: 'Acme' },
      })
    );
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).not.toHaveProperty('stripeCustomerId');
  });

  it.each([[{ role: 'owner' }], [{ role: 'admin' }], [{}]])('refuses body %j before the service', async body => {
    const { run } = call(body);
    await Promise.resolve(run()).catch(() => undefined);

    expect(setOrganizationMemberRole).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('does not audit a request that changed nothing', async () => {
    setOrganizationMemberRole.mockResolvedValueOnce({
      organization: { id: 'org1', name: 'Acme', userId: 'owner1' },
      previousRole: 'manager',
      role: 'manager',
      changed: false,
    });
    const { res, run } = call({ role: 'manager' });
    await run();

    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
    expect(res._getStatusCode()).toBe(200);
  });

  it('writes the role and its strict audit in one transaction, and surfaces an audit failure', async () => {
    const depthAtWrite: number[] = [];
    setOrganizationMemberRole.mockImplementationOnce(async () => {
      depthAtWrite.push(transaction.depth);
      return {
        organization: { id: 'org1', name: 'Acme', userId: 'owner1' },
        previousRole: 'member',
        role: 'manager',
        changed: true,
      };
    });
    recordAdminActionFromRequest.mockImplementationOnce(async () => {
      depthAtWrite.push(transaction.depth);
      throw new Error('audit down');
    });
    const { run } = call({ role: 'manager' });

    await expect(Promise.resolve(run())).rejects.toThrow('audit down');
    expect(depthAtWrite).toEqual([1, 1]);
  });

  it('does not audit when the service refuses', async () => {
    setOrganizationMemberRole.mockRejectedValueOnce(new Error('Organization not found'));
    const { run } = call({ role: 'manager' });
    // asyncHandler may rethrow or hand the error to the error middleware; either way nothing is audited.
    await Promise.resolve(run()).catch(() => undefined);

    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });
});
