import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminApproval } from '@bike4mind/common';
import type { Request } from 'express';

const mocks = vi.hoisted(() => ({ adminUpdateUser: vi.fn(), findById: vi.fn(), audit: vi.fn() }));

vi.mock('@bike4mind/database', () => ({
  Organization: {},
  creditTransactionRepository: {},
  friendshipRepository: {},
  realtimeConnectionRepository: {},
  userRepository: { findById: mocks.findById },
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: {} }));
vi.mock('@bike4mind/services', () => ({ userService: { adminUpdateUser: mocks.adminUpdateUser } }));
vi.mock('@bike4mind/server-utils/auth/adminRoles', () => ({ resolveRoleAdminPermissions: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest: mocks.audit }));
vi.mock('@server/admin/approvals/auditWriter', () => ({
  approvalAuditDetails: (approval: AdminApproval) => ({ id: approval.id }),
}));

const { SelfCreditAdjustmentParamsSchema, applyApprovedSelfCreditAdjustment } = await import('./selfCreditAdjustment');

const REQUESTER = 'requester1';
const approval = { id: 'approval1', requestedBy: { id: REQUESTER, selfIds: [REQUESTER] } } as unknown as AdminApproval;
const req = { user: { id: 'approver1', isAdmin: true } } as unknown as Request;
const params = { userId: REQUESTER, creditDelta: 50, creditReason: 'Testing credits' };

describe('applyApprovedSelfCreditAdjustment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findById.mockResolvedValue({ id: REQUESTER, name: 'Ada' });
    mocks.adminUpdateUser.mockResolvedValue({
      creditAdjustment: {
        credits: 50,
        previousBalance: 10,
        resultingBalance: 60,
        note: 'Testing credits',
        creditTransactionId: 'ctx1',
      },
    });
  });

  it('applies the stored delta as the requester, not the approver, and audits it as an approved self-grant', async () => {
    const result = await applyApprovedSelfCreditAdjustment(req, params, approval);

    expect(result).toEqual({ userId: REQUESTER, appliedCreditDelta: 50, currentCredits: 60 });
    expect(mocks.adminUpdateUser).toHaveBeenCalledWith(
      REQUESTER,
      { id: REQUESTER, creditDelta: 50, creditReason: 'Testing credits' },
      expect.anything()
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'user.credits.adjusted',
        details: { credits: 50, selfGrant: true, approval: { id: 'approval1' } },
        related: { creditTransactionId: 'ctx1' },
      })
    );
  });

  it("refuses params that no longer target the requester's own account", async () => {
    await expect(
      applyApprovedSelfCreditAdjustment(req, { ...params, userId: 'someone-else' }, approval)
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.adminUpdateUser).not.toHaveBeenCalled();
  });

  it('accepts only a positive whole delta', () => {
    expect(SelfCreditAdjustmentParamsSchema.safeParse({ ...params, creditDelta: -5 }).success).toBe(false);
    expect(SelfCreditAdjustmentParamsSchema.safeParse({ ...params, creditDelta: 1.5 }).success).toBe(false);
    expect(SelfCreditAdjustmentParamsSchema.safeParse({ ...params, extra: 1 }).success).toBe(false);
  });
});
