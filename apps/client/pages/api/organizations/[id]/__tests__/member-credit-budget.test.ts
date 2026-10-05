import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * PUT /api/organizations/[id]/member-credit-budget. Authorization and validation live in
 * organizationService.setMemberCreditDefault (memberCreditBudget.test.ts); this pins the route's
 * own contract: the API-key scope gate, the service wiring, and the audit record.
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

const setMemberCreditDefault = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services', () => ({ organizationService: { setMemberCreditDefault } }));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: { marker: 'orgRepo' } }));
const logAuditEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@server/utils/auditLog', () => ({
  AdminOrgAuditEvents: { ORG_MEMBER_CREDIT_BUDGET_UPDATED: 'ORG_MEMBER_CREDIT_BUDGET_UPDATED' },
  logAuditEvent,
}));

import '@pages/api/organizations/[id]/member-credit-budget';

const put = (body: unknown) => {
  const { req, res } = createMocks({ method: 'PUT', query: { id: 'org1' }, body });
  (req as any).user = { id: 'owner1', isAdmin: false };
  return { res, run: () => mockRefs.putHandler!(req, res) };
};

describe('PUT /api/organizations/[id]/member-credit-budget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMemberCreditDefault.mockResolvedValue({
      organization: { id: 'org1', userId: 'owner1', maxCreditsPerMember: 500 },
      previous: 100,
      current: 500,
    });
  });

  it('requires the admin:* API-key scope', () => {
    expect(mockRefs.baseApiOptions).toEqual({ requiredScopes: ['admin:*'] });
  });

  it('passes the caller and body to the service and audits before/after', async () => {
    const { res, run } = put({ maxCreditsPerMember: 500 });
    await run();

    expect(setMemberCreditDefault).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'owner1' }),
      { organizationId: 'org1', maxCreditsPerMember: 500 },
      { db: { organizations: { marker: 'orgRepo' } } }
    );
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner1',
        action: 'ORG_MEMBER_CREDIT_BUDGET_UPDATED',
        metadata: { organizationId: 'org1', previous: 100, current: 500 },
      }),
      undefined
    );
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ id: 'org1', maxCreditsPerMember: 500 });
  });

  it('rejects a body without the field before calling the service', async () => {
    const { run } = put({});
    await expect(run()).rejects.toThrow();
    expect(setMemberCreditDefault).not.toHaveBeenCalled();
  });
});
