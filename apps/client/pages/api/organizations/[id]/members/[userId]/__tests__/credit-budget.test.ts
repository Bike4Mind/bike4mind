import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * PUT /api/organizations/[id]/members/[userId]/credit-budget. Authorization, membership and
 * validation live in organizationService.setMemberCreditOverride (memberCreditBudget.test.ts);
 * this pins the route's own contract: the API-key scope gate, the service wiring, and the audit.
 */

const mockRefs = vi.hoisted(() => ({
  putHandler: null as null | ((req: any, res: any) => unknown),
  baseApiOptions: undefined as unknown,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    put: (fn: any) => {
      mockRefs.putHandler = fn;
      return chain;
    },
  };
  return {
    baseApi: (options: unknown) => {
      mockRefs.baseApiOptions = options;
      return chain;
    },
  };
});

const setMemberCreditOverride = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services', () => ({ organizationService: { setMemberCreditOverride } }));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: { marker: 'orgRepo' } }));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: { marker: 'userRepo' } }));
const logAuditEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@server/utils/auditLog', () => ({
  AdminOrgAuditEvents: { ORG_MEMBER_CREDIT_BUDGET_UPDATED: 'ORG_MEMBER_CREDIT_BUDGET_UPDATED' },
  logAuditEvent,
}));

import '@pages/api/organizations/[id]/members/[userId]/credit-budget';

const put = (body: unknown, query: Record<string, string> = { id: 'org1', userId: 'member1' }) => {
  const { req, res } = createMocks({ method: 'PUT', query, body });
  (req as any).user = { id: 'orgAdmin1', isAdmin: false };
  return { res, run: () => mockRefs.putHandler!(req, res) };
};

describe('PUT /api/organizations/[id]/members/[userId]/credit-budget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMemberCreditOverride.mockResolvedValue({
      organization: { id: 'org1', userId: 'owner1' },
      previous: 25,
      current: 0,
    });
  });

  it('requires the admin:* API-key scope (not the datalake:share scope of its index.ts sibling)', () => {
    expect(mockRefs.baseApiOptions).toEqual({ requiredScopes: ['admin:*'] });
  });

  it('passes the caller, member and override to the service and audits the target member', async () => {
    const { res, run } = put({ maxCredits: 0 });
    await run();

    expect(setMemberCreditOverride).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'orgAdmin1' }),
      { organizationId: 'org1', userId: 'member1', maxCredits: 0 },
      { db: { organizations: { marker: 'orgRepo' }, users: { marker: 'userRepo' } } }
    );
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ORG_MEMBER_CREDIT_BUDGET_UPDATED',
        metadata: { organizationId: 'org1', memberUserId: 'member1', previous: 25, current: 0 },
      }),
      undefined
    );
    expect(res._getStatusCode()).toBe(200);
  });

  it('rejects a missing member id before calling the service', async () => {
    const { run } = put({ maxCredits: 5 }, { id: 'org1' });
    await expect(run()).rejects.toThrow('Invalid organization or member id');
    expect(setMemberCreditOverride).not.toHaveBeenCalled();
  });

  it('propagates a service refusal and writes no audit record', async () => {
    setMemberCreditOverride.mockRejectedValue(new Error('Member not found'));
    const { run } = put({ maxCredits: 5 });
    await expect(run()).rejects.toThrow('Member not found');
    expect(logAuditEvent).not.toHaveBeenCalled();
  });
});
