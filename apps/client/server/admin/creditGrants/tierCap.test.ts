// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminActionReasonSchema, type AdminApproval } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({ received: vi.fn(), orgReceived: vi.fn(), audit: vi.fn() }));
const config = vi.hoisted(() => ({ ADMIN_SENIOR_GRANTER_IDS: undefined as string | undefined }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: config }));
vi.mock('@bike4mind/observability', () => ({ Logger: { globalInstance: { error: vi.fn(), warn: vi.fn() } } }));

const reservations = vi.hoisted(() => {
  const rows = new Map<string, { actorUserId: string; kind: string; amount: number }>();
  let next = 0;
  return {
    rows,
    reserve: vi.fn(async (actorUserId: string, kind: string, amount: number) => {
      const id = String(++next);
      rows.set(id, { actorUserId, kind, amount });
      return id;
    }),
    sumReserved: vi.fn(async (actorUserId: string, kind: string) =>
      [...rows.values()].filter(r => r.actorUserId === actorUserId && r.kind === kind).reduce((t, r) => t + r.amount, 0)
    ),
    release: vi.fn(async (id: string) => void rows.delete(id)),
  };
});
vi.mock('@bike4mind/database', () => ({
  adminAuditLogRepository: { sumCreditsGrantedTo: mocks.received, sumCreditsGrantedToOrganization: mocks.orgReceived },
  adminGateReservationRepository: reservations,
}));
vi.mock('@server/admin/approvals/service', () => ({ getApprovalPolicy: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  readAdminActionReason: (value: unknown) => {
    const parsed = AdminActionReasonSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  },
  isSelfOrImpersonator: (user: { id: string; impersonatedBy?: string | null }, targetId: string) =>
    user.id === targetId || user.impersonatedBy === targetId,
}));

import {
  checkCreditGrantCap,
  enforceCreditGrantCap,
  enforceImmediateCreditGrant,
  immediateGrantLimit,
  isLargeGrantApproval,
  usersBulkCreditGrantCap,
  type CreditGrantCapRequest,
} from './tierCap';

// Fake ids only.
const APPROVER_ID = 'a00000000000000000000001';
const SELF_GRANTER_ID = 'd00000000000000000000004';
const UNLISTED_ID = 'b00000000000000000000002';
const RECIPIENT = { id: 'e00000000000000000000005', displayName: 'user@example.com' };
const REASON = 'Enterprise pilot onboarding grant';

const STANDARD = { id: UNLISTED_ID, isAdmin: true };
const APPROVER = { id: APPROVER_ID, adminPermissions: ['credits:adjust', 'credits:approve_self_grant'] };
const SELF_GRANTER = { id: SELF_GRANTER_ID, adminPermissions: ['credits:adjust', 'credits:self_grant'] };
const UNLISTED_APPROVER = { id: UNLISTED_ID, adminPermissions: ['credits:adjust', 'credits:approve_self_grant'] };

const request = (overrides: Partial<CreditGrantCapRequest>): CreditGrantCapRequest => ({
  actor: STANDARD,
  recipient: RECIPIENT,
  credits: 1000,
  targetsSelf: false,
  approvalAvailable: true,
  reason: REASON,
  attemptedAction: 'user.credits.adjusted',
  ...overrides,
});
const confirmed = (overrides: Partial<CreditGrantCapRequest>) => request({ confirmLargeGrant: true, ...overrides });

const refusalOf = async (overrides: Partial<CreditGrantCapRequest>) => {
  const result = await checkCreditGrantCap(request(overrides), mocks.audit);
  if (result.outcome !== 'refused') throw new Error(`expected a refusal, got ${result.outcome}`);
  return result.refusal;
};

beforeEach(() => {
  vi.clearAllMocks();
  reservations.rows.clear();
  mocks.received.mockResolvedValue(0);
  mocks.orgReceived.mockResolvedValue(0);
  mocks.audit.mockResolvedValue(null);
  config.ADMIN_SENIOR_GRANTER_IDS = `c00000000000000000000003, ${APPROVER_ID},${SELF_GRANTER_ID}`;
});

describe('immediateGrantLimit', () => {
  it.each([
    ['a full admin, who does not imply the explicit-only permissions', STANDARD, false, 100_000],
    ['a listed full admin without credits:approve_self_grant', { id: APPROVER_ID, isAdmin: true }, false, 100_000],
    ['a listed approver granting others', APPROVER, false, 500_000],
    ['a listed approver granting themselves', APPROVER, true, 100_000],
    [
      'a listed approver holding the permission through a role',
      { id: APPROVER_ID, roleAdminPermissions: ['credits:adjust', 'credits:approve_self_grant'] },
      false,
      500_000,
    ],
    ['an unlisted holder of credits:approve_self_grant', UNLISTED_APPROVER, false, 100_000],
    [
      'a listed approver without credits:adjust',
      { id: APPROVER_ID, adminPermissions: ['credits:approve_self_grant'] },
      false,
      100_000,
    ],
    ['a session impersonating a listed approver', { ...APPROVER, impersonatedBy: UNLISTED_ID }, false, 100_000],
    ['a listed credits:self_grant holder granting themselves', SELF_GRANTER, true, 500_000],
    ['a listed credits:self_grant holder granting others', SELF_GRANTER, false, 100_000],
    ['an unlisted credits:self_grant holder granting themselves', { ...SELF_GRANTER, id: UNLISTED_ID }, true, 100_000],
  ])('gives %s %i', (_label, actor, targetsSelf, limit) => {
    expect(immediateGrantLimit(actor, targetsSelf)).toBe(limit);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['only separators and spaces', ' , ,'],
  ])('fails closed when the list is %s', (_label, raw) => {
    config.ADMIN_SENIOR_GRANTER_IDS = raw;
    expect(immediateGrantLimit(APPROVER, false)).toBe(100_000);
  });
});

describe('checkCreditGrantCap', () => {
  it('never checks a deduction or a zero change', async () => {
    for (const credits of [0, -900_000]) {
      expect((await checkCreditGrantCap(request({ credits }), mocks.audit)).outcome).toBe('immediate');
    }
    expect(reservations.reserve).not.toHaveBeenCalled();
    expect(mocks.received).not.toHaveBeenCalled();
  });

  describe('any admin with credits:adjust', () => {
    it.each([false, true])(
      'grants up to 100,000 at once (targetsSelf %s), reserved against the recipient for 24 hours',
      async targetsSelf => {
        const before = Date.now();
        const result = await checkCreditGrantCap(request({ credits: 100_000, targetsSelf }), mocks.audit);

        expect(result.outcome).toBe('immediate');
        expect(reservations.reserve).toHaveBeenCalledWith(RECIPIENT.id, 'recipientCredits', 100_000, expect.any(Date));
        const expiresAt = reservations.reserve.mock.calls[0][3] as unknown as Date;
        expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
        const since = mocks.received.mock.calls[0][1] as Date;
        expect(before - since.getTime()).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000);
        if (result.outcome === 'immediate') await result.release();
        expect(reservations.rows.size).toBe(0);
        expect(mocks.audit).not.toHaveBeenCalled();
      }
    );

    it.each([false, true])(
      'turns the whole grant above 100,000 into one approval request (targetsSelf %s)',
      async targetsSelf => {
        const result = await checkCreditGrantCap(confirmed({ credits: 150_000, targetsSelf }), mocks.audit);

        expect(result).toEqual({ outcome: 'approval' });
        expect(reservations.reserve).not.toHaveBeenCalled();
        expect(mocks.audit).not.toHaveBeenCalled();
      }
    );

    it('sums what every admin granted the recipient, so a split second grant still goes for approval', async () => {
      mocks.received.mockResolvedValue(80_000);
      expect(await checkCreditGrantCap(confirmed({ credits: 30_000 }), mocks.audit)).toEqual({ outcome: 'approval' });
    });

    it('refuses a request over 100,000 without the typed phrase and states what runs now', async () => {
      mocks.received.mockResolvedValue(30_000);
      expect(await refusalOf({ credits: 100_000 })).toEqual({
        subject: 'user',
        reason: 'confirmation_required',
        receivedCredits: 30_000,
        remainingCredits: 70_000,
        message:
          "This user has received 30,000 admin-granted credits in the last 24 hours. Above 100,000 the whole grant needs a senior granter's approval: type the confirmation and give a reason to submit it, or grant up to 70,000 now.",
      });
    });

    it('refuses the typed phrase without a reason', async () => {
      expect((await refusalOf({ credits: 150_000, confirmLargeGrant: true, reason: undefined })).reason).toBe(
        'confirmation_required'
      );
    });

    it('refuses instead of queueing where the path cannot ask for approval', async () => {
      expect((await refusalOf({ credits: 150_000, confirmLargeGrant: true, approvalAvailable: false })).reason).toBe(
        'approval_unavailable'
      );
    });

    it('counts concurrent in-flight grants to the same recipient', async () => {
      const first = await checkCreditGrantCap(request({ credits: 80_000 }), mocks.audit);
      const second = await checkCreditGrantCap(confirmed({ credits: 30_000 }), mocks.audit);

      expect(first.outcome).toBe('immediate');
      expect(second.outcome).toBe('approval');
      if (first.outcome === 'immediate') await first.release();
      expect((await checkCreditGrantCap(request({ credits: 30_000 }), mocks.audit)).outcome).toBe('immediate');
    });
  });

  describe('a listed approver', () => {
    it('grants others up to 500,000 at once with the typed phrase', async () => {
      mocks.received.mockResolvedValue(100_000);
      const result = await checkCreditGrantCap(confirmed({ actor: APPROVER, credits: 400_000 }), mocks.audit);

      expect(result.outcome).toBe('immediate');
      expect(reservations.reserve).toHaveBeenCalledWith(RECIPIENT.id, 'recipientCredits', 400_000, expect.any(Date));
    });

    it('still needs the phrase and a reason past 100,000', async () => {
      expect(await refusalOf({ actor: APPROVER, credits: 150_000 })).toMatchObject({
        reason: 'confirmation_required',
        remainingCredits: 100_000,
        message: expect.stringContaining(
          'Going above 100,000 needs the typed confirmation and a reason, so without it you can grant up to 100,000 more.'
        ),
      });
    });

    it('sends their own grant above 100,000 for another approver', async () => {
      const result = await checkCreditGrantCap(
        confirmed({ actor: APPROVER, credits: 150_000, targetsSelf: true }),
        mocks.audit
      );
      expect(result).toEqual({ outcome: 'approval' });
    });

    it('is a standard admin when not on the list, whatever they hold', async () => {
      const result = await checkCreditGrantCap(confirmed({ actor: UNLISTED_APPROVER, credits: 150_000 }), mocks.audit);
      expect(result).toEqual({ outcome: 'approval' });
    });

    it('is a standard admin while impersonating', async () => {
      const actor = { ...APPROVER, impersonatedBy: UNLISTED_ID };
      expect(await checkCreditGrantCap(confirmed({ actor, credits: 150_000 }), mocks.audit)).toEqual({
        outcome: 'approval',
      });
    });
  });

  it('lets a listed credits:self_grant holder grant themselves up to 500,000 at once, never more', async () => {
    const actor = SELF_GRANTER;
    expect(
      (await checkCreditGrantCap(confirmed({ actor, credits: 400_000, targetsSelf: true }), mocks.audit)).outcome
    ).toBe('immediate');
    reservations.rows.clear();
    expect((await refusalOf({ actor, credits: 500_001, targetsSelf: true, confirmLargeGrant: true })).reason).toBe(
      'hard_limit'
    );
  });

  describe('the 500,000 hard limit', () => {
    it.each([
      ['an approver granting at once', { actor: APPROVER }],
      ['an approved grant', { approved: true }],
      ['a standard admin who would ask for approval', {}],
    ])('refuses %s past it and states what is left', async (_label, extra) => {
      mocks.received.mockResolvedValue(450_000);
      expect(await refusalOf({ credits: 60_000, confirmLargeGrant: true, ...extra })).toEqual({
        subject: 'user',
        reason: 'hard_limit',
        receivedCredits: 450_000,
        remainingCredits: 50_000,
        message:
          'This user has received 450,000 admin-granted credits in the last 24 hours. No grant can take it above 500,000 in 24 hours, approved or not, so at most 50,000 more can be granted.',
      });
    });

    it('runs an approved grant up to it without asking for the phrase again', async () => {
      const result = await checkCreditGrantCap(request({ credits: 300_000, approved: true }), mocks.audit);
      expect(result.outcome).toBe('immediate');
      expect(reservations.reserve).toHaveBeenCalledWith(RECIPIENT.id, 'recipientCredits', 300_000, expect.any(Date));
    });

    it('does not apply to a subscription grant: above 100,000 it goes for approval, then runs', async () => {
      mocks.received.mockResolvedValue(450_000);
      const subscription = { credits: 900_000, exemptFromHardLimit: true };

      expect(await checkCreditGrantCap(confirmed(subscription), mocks.audit)).toEqual({ outcome: 'approval' });
      expect((await checkCreditGrantCap(request({ ...subscription, approved: true }), mocks.audit)).outcome).toBe(
        'immediate'
      );
    });
  });

  describe('boundaries', () => {
    const outcomeOf = async (overrides: Partial<CreditGrantCapRequest>) => {
      const result = await checkCreditGrantCap(request(overrides), mocks.audit);
      return result.outcome === 'refused' ? result.refusal.reason : result.outcome;
    };

    it.each([
      ['100,000 runs at once', {}, 0, 100_000, 'immediate'],
      ['100,001 without the phrase is refused', {}, 0, 100_001, 'confirmation_required'],
      ['100,001 with the phrase goes for approval', { confirmLargeGrant: true }, 0, 100_001, 'approval'],
      [
        '500,000 (400,000 received + 100,000) runs for a listed approver with the phrase',
        { actor: APPROVER, confirmLargeGrant: true },
        400_000,
        100_000,
        'immediate',
      ],
      ['500,000 runs on an approval', { approved: true }, 400_000, 100_000, 'immediate'],
      [
        '500,001 is refused for a listed approver',
        { actor: APPROVER, confirmLargeGrant: true },
        400_000,
        100_001,
        'hard_limit',
      ],
      ['500,001 is refused on an approval', { approved: true }, 400_000, 100_001, 'hard_limit'],
    ])('%s', async (_label, overrides, received, credits, expected) => {
      mocks.received.mockResolvedValue(received);
      expect(await outcomeOf({ credits, ...overrides })).toBe(expected);
    });
  });

  describe('a grant that loses a reservation race', () => {
    // The pre-check reads `before`; by the time the grant reserves, other grants have taken the recipient to `later`.
    const raced = (before: number, later: number) =>
      mocks.received.mockResolvedValueOnce(before).mockResolvedValue(later);

    it.each([
      [
        'queues the whole grant when the path can ask for approval and has the phrase',
        { confirmLargeGrant: true },
        80_000,
        'approval',
      ],
      ['asks for the phrase when the path can ask for approval', {}, 80_000, 'confirmation_required'],
      [
        'refuses where the path cannot ask for approval',
        { confirmLargeGrant: true, approvalAvailable: false },
        80_000,
        'approval_unavailable',
      ],
      ['refuses at the hard limit, phrase or not', { confirmLargeGrant: true }, 460_000, 'hard_limit'],
    ])('%s', async (_label, overrides, later, expected) => {
      raced(0, later);
      const result = await checkCreditGrantCap(request({ credits: 50_000, ...overrides }), mocks.audit);

      expect(result.outcome === 'refused' ? result.refusal.reason : result.outcome).toBe(expected);
      expect(reservations.rows.size).toBe(0);
    });

    it("refuses a listed approver's unconfirmed grant that concurrent grants took past 100,000", async () => {
      const first = await checkCreditGrantCap(request({ actor: APPROVER, credits: 60_000 }), mocks.audit);
      expect(first.outcome).toBe('immediate');
      // The second grant read the recipient before the first one reserved.
      reservations.sumReserved.mockResolvedValueOnce(0);

      expect(await refusalOf({ actor: APPROVER, credits: 60_000 })).toMatchObject({
        reason: 'confirmation_required',
        receivedCredits: 60_000,
        remainingCredits: 40_000,
      });
      expect([...reservations.rows.values()]).toEqual([
        { actorUserId: RECIPIENT.id, kind: 'recipientCredits', amount: 60_000 },
      ]);

      reservations.sumReserved.mockResolvedValueOnce(0);
      const confirmedSecond = await checkCreditGrantCap(confirmed({ actor: APPROVER, credits: 60_000 }), mocks.audit);
      expect(confirmedSecond.outcome).toBe('immediate');
    });
  });

  it('releases an acquired hold when the post-hold confirmation read fails', async () => {
    const failure = new Error('post-hold history read unavailable');
    mocks.received.mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockRejectedValueOnce(failure);

    await expect(checkCreditGrantCap(request({ actor: APPROVER, credits: 60_000 }), mocks.audit)).rejects.toBe(failure);

    expect(reservations.rows.size).toBe(0);
    const retry = await checkCreditGrantCap(request({ actor: APPROVER, credits: 60_000 }), mocks.audit);
    expect(retry.outcome).toBe('immediate');
    if (retry.outcome === 'immediate') await retry.release();
    expect(reservations.rows.size).toBe(0);
  });

  it('releases the first subject hold when acquiring the second subject fails', async () => {
    const failure = new Error('organization history read unavailable');
    mocks.orgReceived.mockResolvedValueOnce(0).mockRejectedValueOnce(failure);

    await expect(
      checkCreditGrantCap(confirmed({ credits: 60_000, organizationId: 'organization' }), mocks.audit)
    ).rejects.toBe(failure);

    expect(reservations.rows.size).toBe(0);
  });

  it('writes every refusal to the admin audit log as user.credits.denied', async () => {
    mocks.received.mockResolvedValue(90_000);

    await checkCreditGrantCap(request({ credits: 20_000, attemptedAction: 'user.subscription.granted' }), mocks.audit);

    expect(mocks.audit).toHaveBeenCalledWith({
      action: 'user.credits.denied',
      target: { kind: 'user', ...RECIPIENT },
      summary: 'refused a grant of 20,000 credits over the 24-hour per-user grant limit',
      reason: REASON,
      details: {
        attemptedAction: 'user.subscription.granted',
        requestedCredits: 20_000,
        limitedBy: 'user',
        refusal: 'confirmation_required',
        receivedCredits: 90_000,
        immediateLimit: 100_000,
        approved: false,
        largeGrantConfirmed: false,
      },
    });
  });

  describe('a team grant', () => {
    const ORG = 'f00000000000000000000006';
    const team = { countRecipient: false, organizationId: ORG };

    it('counts against the organization, not the member', async () => {
      mocks.received.mockResolvedValue(95_000);
      mocks.orgReceived.mockResolvedValue(80_000);

      expect(await checkCreditGrantCap(confirmed({ ...team, credits: 30_000 }), mocks.audit)).toEqual({
        outcome: 'approval',
      });
      const result = await checkCreditGrantCap(request({ ...team, credits: 20_000 }), mocks.audit);
      expect(result.outcome).toBe('immediate');
      expect([...reservations.rows.values()]).toEqual([
        { actorUserId: ORG, kind: 'organizationCredits', amount: 20_000 },
      ]);
      expect(mocks.received).not.toHaveBeenCalled();
    });

    it('audits an organization refusal with the organization', async () => {
      mocks.orgReceived.mockResolvedValue(95_000);

      expect(await refusalOf({ ...team, credits: 6_000 })).toMatchObject({
        subject: 'organization',
        receivedCredits: 95_000,
        remainingCredits: 5_000,
        message: expect.stringMatching(/^This organization has received 95,000 admin-granted credits/),
      });
      expect(mocks.audit).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { kind: 'user', ...RECIPIENT },
          organizationId: ORG,
          summary: 'refused a grant of 6,000 credits over the 24-hour per-organization grant limit',
          details: expect.objectContaining({ limitedBy: 'organization' }),
        })
      );
    });

    it('counts concurrent grants to different members against the organization', async () => {
      const first = await checkCreditGrantCap(
        request({ ...team, credits: 80_000, recipient: { id: 'user-a', displayName: 'a' } }),
        mocks.audit
      );
      const second = await checkCreditGrantCap(
        confirmed({ ...team, credits: 30_000, recipient: { id: 'user-b', displayName: 'b' } }),
        mocks.audit
      );
      expect(first.outcome).toBe('immediate');
      expect(second.outcome).toBe('approval');
    });

    it('judges a grant to a new organization on its own credits', async () => {
      const fresh = { countRecipient: false };
      expect((await checkCreditGrantCap(request({ ...fresh, credits: 100_000 }), mocks.audit)).outcome).toBe(
        'immediate'
      );
      expect(await checkCreditGrantCap(confirmed({ ...fresh, credits: 150_000 }), mocks.audit)).toEqual({
        outcome: 'approval',
      });
      expect(reservations.reserve).not.toHaveBeenCalled();
    });
  });

  it('only reads in pre-check mode, counting reservations already held', async () => {
    reservations.rows.set('held', { actorUserId: RECIPIENT.id, kind: 'recipientCredits', amount: 60_000 });

    const options = { reserve: false };
    expect((await checkCreditGrantCap(request({ credits: 40_000 }), mocks.audit, options)).outcome).toBe('immediate');
    expect((await checkCreditGrantCap(confirmed({ credits: 40_001 }), mocks.audit, options)).outcome).toBe('approval');
    expect(reservations.reserve).not.toHaveBeenCalled();
  });
});

describe('enforceCreditGrantCap', () => {
  it('throws a 403 carrying the refusal fields', async () => {
    mocks.received.mockResolvedValue(30_000);
    await expect(enforceCreditGrantCap(request({ credits: 100_000 }), mocks.audit)).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining('or grant up to 70,000 now'),
      additionalInfo: {
        code: 'admin_grant_limit',
        subject: 'user',
        reason: 'confirmation_required',
        receivedCredits: 30_000,
        remainingCredits: 70_000,
      },
    });
  });

  it('returns an approval outcome', async () => {
    expect(await enforceCreditGrantCap(confirmed({ credits: 150_000 }), mocks.audit)).toEqual({ outcome: 'approval' });
  });
});

describe('enforceImmediateCreditGrant', () => {
  it('refuses what would need approval, since the grant must run now', async () => {
    const immediate = {
      actor: STANDARD,
      recipient: RECIPIENT,
      credits: 150_000,
      targetsSelf: false,
      confirmLargeGrant: true,
      reason: REASON,
      attemptedAction: 'user.credits.adjusted' as const,
    };
    await expect(enforceImmediateCreditGrant(immediate, mocks.audit)).rejects.toMatchObject({
      statusCode: 403,
      additionalInfo: { reason: 'approval_unavailable' },
    });
  });
});

describe('isLargeGrantApproval', () => {
  it('is true only for an approval routed to credits:approve_self_grant', () => {
    const approval = (requiredPermission: string) => ({ requiredPermission }) as AdminApproval;
    expect(isLargeGrantApproval(approval('credits:approve_self_grant'))).toBe(true);
    expect(isLargeGrantApproval(approval('credits:adjust'))).toBe(false);
    expect(isLargeGrantApproval(undefined)).toBe(false);
  });
});

describe('usersBulkCreditGrantCap', () => {
  const user = {
    id: RECIPIENT.id,
    name: null,
    email: 'user@example.com',
    username: null,
    isAdmin: false,
    isBanned: false,
    isModerated: false,
    tags: [],
    currentCredits: 0,
    disputePending: false,
    moderationStatus: null,
  };

  it('fails a user the batch would take past 100,000, since a batch cannot ask for approval', async () => {
    mocks.received.mockResolvedValue(50_000);

    const hold = await usersBulkCreditGrantCap(STANDARD, mocks.audit, REASON)(user, 100_000);

    expect(hold).toEqual({
      allowed: false,
      message: expect.stringContaining("needs a senior granter's approval, which this action cannot request"),
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ attemptedAction: 'user.bulk.credits_adjusted' }) })
    );
  });

  it('fails it for a listed approver too, since a batch cannot take the typed phrase', async () => {
    mocks.received.mockResolvedValue(50_000);
    const hold = await usersBulkCreditGrantCap(APPROVER, mocks.audit, REASON)(user, 100_000);
    expect(hold).toEqual({
      allowed: false,
      message: expect.stringContaining('the typed confirmation, which this action cannot take'),
    });
  });

  it('holds an allowed grant until released', async () => {
    const hold = await usersBulkCreditGrantCap(STANDARD, mocks.audit, REASON)(user, 100_000);
    expect(hold.allowed).toBe(true);
    expect(reservations.rows.size).toBe(1);
    if (hold.allowed) await hold.release();
    expect(reservations.rows.size).toBe(0);
  });
});
