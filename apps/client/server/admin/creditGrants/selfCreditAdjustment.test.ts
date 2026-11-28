import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminApproval } from '@bike4mind/common';
import type { Request } from 'express';

const mocks = vi.hoisted(() => ({
  addCreditsWithLedgerRow: vi.fn(),
  findUnreversedPurchase: vi.fn(),
  findById: vi.fn(),
  audit: vi.fn(),
  received: vi.fn(),
}));
const reservations = vi.hoisted(() => new Map<string, number>());

vi.mock('@bike4mind/database', () => ({
  Organization: {},
  creditTransactionRepository: { findUnreversedPurchase: mocks.findUnreversedPurchase },
  friendshipRepository: {},
  realtimeConnectionRepository: {},
  userRepository: { findById: mocks.findById },
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
  // The real grant cap (tierCap.ts) runs over these.
  adminAuditLogRepository: { sumCreditsGrantedTo: mocks.received },
  adminGateReservationRepository: {
    reserve: async (_subjectId: string, _kind: string, amount: number) => {
      const id = String(reservations.size + 1);
      reservations.set(id, amount);
      return id;
    },
    sumReserved: async () => [...reservations.values()].reduce((total, amount) => total + amount, 0),
    release: async (id: string) => void reservations.delete(id),
  },
}));
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: {} }));
vi.mock('@bike4mind/services', () => ({ creditService: { addCreditsWithLedgerRow: mocks.addCreditsWithLedgerRow } }));
vi.mock('@bike4mind/server-utils/auth/adminRoles', () => ({ resolveRoleAdminPermissions: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>()),
  recordAdminActionFromRequest: mocks.audit,
}));
// Every account counts as listed here; the senior granter list is covered by seniorGranters.test.ts.
vi.mock('./seniorGranters', () => ({ fenceExplicitOnlyPermissions: <T>(actor: T) => actor }));
vi.mock('@server/admin/approvals/auditWriter', () => ({
  approvalAuditDetails: (approval: AdminApproval) => ({ id: approval.id }),
}));

const { SelfCreditAdjustmentParamsSchema, applyApprovedCreditGrant, applyApprovedSelfCreditAdjustment } =
  await import('./selfCreditAdjustment');

const REQUESTER = 'requester1';
const approval = {
  id: 'approval1',
  requiredPermission: 'credits:approve_self_grant',
  requestedBy: { id: REQUESTER, selfIds: [REQUESTER] },
} as unknown as AdminApproval;
const req = { user: { id: 'approver1', isAdmin: true } } as unknown as Request;
const params = { userId: REQUESTER, creditDelta: 50, creditReason: 'Testing credits' };

beforeEach(() => {
  reservations.clear();
  mocks.findUnreversedPurchase.mockResolvedValue(null);
  mocks.received.mockReset().mockResolvedValue(0);
});

describe('applyApprovedSelfCreditAdjustment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findById.mockResolvedValue({ id: REQUESTER, name: 'Ada', currentCredits: 10 });
    mocks.addCreditsWithLedgerRow.mockResolvedValue({
      creditHolder: { currentCredits: 60 },
      creditTransactionId: 'ctx1',
    });
  });

  it('credits the requester with the real approver on its ledger and audit', async () => {
    const result = await applyApprovedSelfCreditAdjustment(req, params, approval);

    expect(result).toEqual({ userId: REQUESTER, appliedCreditDelta: 50, currentCredits: 60 });
    expect(mocks.addCreditsWithLedgerRow).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: REQUESTER,
        credits: 50,
        metadata: expect.objectContaining({ actorId: 'approver1', previousBalance: 10 }),
      }),
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
    expect(mocks.addCreditsWithLedgerRow).not.toHaveBeenCalled();
  });

  it('accepts only a positive whole delta', () => {
    expect(SelfCreditAdjustmentParamsSchema.safeParse({ ...params, creditDelta: -5 }).success).toBe(false);
    expect(SelfCreditAdjustmentParamsSchema.safeParse({ ...params, creditDelta: 1.5 }).success).toBe(false);
    expect(SelfCreditAdjustmentParamsSchema.safeParse({ ...params, extra: 1 }).success).toBe(false);
  });
});

describe('applyApprovedCreditGrant', () => {
  const RECIPIENT = 'recipient1';
  const grantParams = { userId: RECIPIENT, creditDelta: 300_000, creditReason: 'Enterprise pilot onboarding' };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findById.mockResolvedValue({ id: RECIPIENT, name: 'Grace', currentCredits: 0 });
  });

  it('runs the whole grant past the immediate limit on the approval, held until written', async () => {
    let heldDuringWrite = 0;
    mocks.addCreditsWithLedgerRow.mockImplementation(async () => {
      heldDuringWrite = reservations.size;
      return {
        creditHolder: { currentCredits: 300_000 },
        creditTransactionId: 'ctx2',
      };
    });

    const result = await applyApprovedCreditGrant(req, grantParams, approval);

    expect(result).toEqual({ userId: RECIPIENT, appliedCreditDelta: 300_000, currentCredits: 300_000 });
    expect(heldDuringWrite).toBe(1);
    expect(reservations.size).toBe(0);
    expect(mocks.audit).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'user.credits.adjusted',
        details: { credits: 300_000, approval: { id: 'approval1' } },
      })
    );
  });

  it('refuses an approved grant past the 500,000 hard limit and writes nothing', async () => {
    mocks.received.mockResolvedValue(250_000);

    await expect(applyApprovedCreditGrant(req, grantParams, approval)).rejects.toMatchObject({
      statusCode: 403,
      additionalInfo: expect.objectContaining({ reason: 'hard_limit' }),
    });
    expect(mocks.addCreditsWithLedgerRow).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'user.credits.denied',
        details: expect.objectContaining({ approval: { id: 'approval1' } }),
      })
    );
  });

  it('refuses an approver crediting their own account', async () => {
    await expect(applyApprovedCreditGrant(req, { ...grantParams, userId: 'approver1' }, approval)).rejects.toThrow(
      'You cannot approve a credit grant to your own account'
    );
    expect(mocks.addCreditsWithLedgerRow).not.toHaveBeenCalled();
  });
});
