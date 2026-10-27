import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, (req: unknown, res: unknown) => unknown>,
  findRule: vi.fn(),
  findUsers: vi.fn(),
  findOrg: vi.fn(),
  applyMembership: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, (fn: (req: unknown, res: unknown) => unknown) => unknown> = {};
    for (const method of ['get', 'post', 'put', 'delete']) {
      chain[method] = (fn: (req: unknown, res: unknown) => unknown) => {
        h.handlers[method] = fn;
        return chain;
      };
    }
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  partnerSignupRuleRepository: { findById: h.findRule },
  userRepository: { find: h.findUsers },
  organizationRepository: { findById: h.findOrg },
}));
vi.mock('@bike4mind/services', () => ({
  organizationService: { applyPartnerRuleMembership: h.applyMembership },
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  loadTeamPlanSettings: async () => ({ maxSeats: 100 }),
}));
vi.mock('@server/entitlements/assertOrganizationExists', () => ({ assertOrganizationExists: vi.fn() }));
vi.mock('@server/organizations/notifySeatCeilingRaised', () => ({ auditSeatCeilingRaised: vi.fn() }));
vi.mock('@server/integrations/slack/slack', () => ({ postMessageToSlack: vi.fn(async () => undefined) }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import '@pages/api/admin/partner-signup-rules/backfill';

const run = async (commit: boolean) => {
  const { req, res } = createMocks({ method: 'POST' });
  Object.assign(req, {
    user: { isAdmin: true, id: 'admin-1' },
    body: { id: 'r1', commit },
    logger: { error: vi.fn() },
  });
  await h.handlers.post(req, res);
  return { req, res };
};

describe('POST /api/admin/partner-signup-rules/backfill - admin audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findRule.mockResolvedValue({ id: 'r1', domain: 'partner.com', organizationId: 'org-1' });
    h.findUsers.mockResolvedValue([
      { id: 'u1', email: 'a@partner.com' },
      { id: 'u2', email: 'b@partner.com' },
    ]);
    h.findOrg.mockResolvedValue({ id: 'org-1', name: 'Partner Org', users: [], seats: 10 });
    h.applyMembership
      .mockResolvedValueOnce({ added: true, reason: 'added' })
      .mockResolvedValueOnce({ added: false, reason: 'at-capacity' });
    h.audit.mockResolvedValue(null);
  });

  it('records one best-effort .backfilled entry with the run counts after a commit', async () => {
    const { req, res } = await run(true);
    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'org.partner_signup_rule.backfilled',
        target: { kind: 'organization', id: 'org-1', displayName: 'Partner Org' },
        details: expect.objectContaining({ ruleId: 'r1', matched: 2, added: 1, atCapacity: 1 }),
      })
    );
    const lastApply = h.applyMembership.mock.invocationCallOrder.at(-1) ?? 0;
    expect(lastApply).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('does not audit a dry run', async () => {
    const { res } = await run(false);
    expect(res._getJSONData()).toMatchObject({ dryRun: true, matched: 2 });
    expect(h.audit).not.toHaveBeenCalled();
  });
});
