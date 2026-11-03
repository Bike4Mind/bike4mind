import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SignupRiskAutoApprovalSchema } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  findById: vi.fn(),
  autoApprove: vi.fn(),
  pendingIds: vi.fn(),
  attempts: vi.fn(),
  accountsForCard: vi.fn(),
  openDetections: vi.fn(),
  record: vi.fn(),
  settings: vi.fn(),
  inTransaction: false,
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: h.settings,
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: {
    findById: h.findById,
    autoApproveRiskReview: h.autoApprove,
    findPendingRiskReviewIds: h.pendingIds,
  },
  paymentAttemptRepository: { findByUser: h.attempts, countAccountsForCard: h.accountsForCard },
  shadowDetectionRepository: { countOpenForUser: h.openDetections },
  adminAuditLogRepository: {},
  adminSettingsRepository: {},
  withTransaction: async (fn: () => Promise<unknown>) => {
    h.inTransaction = true;
    try {
      return await fn();
    } finally {
      h.inTransaction = false;
    }
  },
}));
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return {
    ...actual,
    adminAuditService: { ...actual.adminAuditService, recordAdminAction: h.record },
  };
});

import {
  autoApproveRiskReview,
  autoApproveRiskReviewAfterPayment,
  sweepRiskReviewAutoApprovals,
} from './riskReviewAutoApproval';

const USER_ID = '1'.repeat(24);
const NOW = new Date('2026-11-03T12:00:00Z');
const DAY_MS = 24 * 60 * 60_000;
const RULES = SignupRiskAutoApprovalSchema.parse({});
const QUIET_ONLY = SignupRiskAutoApprovalSchema.parse({
  settledPayment: { enabled: false },
  quietAccount: { enabled: true },
});
const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };

const pendingUser = (overrides: Record<string, unknown> = {}) => ({
  id: USER_ID,
  email: 'payer@example.org',
  createdAt: new Date(NOW.getTime() - 30 * DAY_MS),
  riskScore: {
    score: 55,
    signals: [],
    computedAt: new Date(NOW.getTime() - 20 * DAY_MS),
    reviewState: 'pending',
  },
  ...overrides,
});

const payment = (overrides: Record<string, unknown> = {}) => ({
  paymentIntentId: 'pi_1',
  userId: USER_ID,
  kind: 'credits',
  outcome: 'succeeded',
  riskLevel: 'normal',
  radarBlocked: false,
  cardFingerprints: ['fp_1'],
  createdAt: new Date(NOW.getTime() - 60_000),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.findById.mockResolvedValue(pendingUser());
  h.autoApprove.mockResolvedValue(true);
  h.attempts.mockResolvedValue([payment()]);
  h.accountsForCard.mockResolvedValue(1);
  h.openDetections.mockResolvedValue(0);
  h.record.mockImplementation(async () => expect(h.inTransaction).toBe(true));
  h.settings.mockResolvedValue({});
});

describe('autoApproveRiskReview: settled payment', () => {
  it('approves on a Radar-normal payment by a card only this account used, with a strict audit entry', async () => {
    const result = await autoApproveRiskReview(USER_ID, { rules: RULES, trigger: 'stripe/webhook', now: NOW });

    expect(result).toEqual({ outcome: 'approved', policy: 'settled_payment' });
    expect(h.accountsForCard).toHaveBeenCalledWith('fp_1');
    expect(h.autoApprove).toHaveBeenCalledWith(USER_ID, { policy: 'settled_payment', decidedAt: NOW });
    expect(h.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.signup_risk.auto_approved',
        actor: expect.objectContaining({ kind: 'system', name: 'signup-risk-auto-approval', wasAdmin: false }),
        target: { kind: 'user', id: USER_ID, displayName: 'payer@example.org' },
        context: { source: 'worker', route: 'stripe/webhook' },
        changes: [{ field: 'riskScore.reviewState', before: 'pending', after: 'approved' }],
      }),
      expect.anything()
    );
  });

  it.each([
    ['an elevated Radar risk', { riskLevel: 'elevated' }],
    ['no Radar assessment', { riskLevel: null }],
    ['a failed payment', { outcome: 'failed' }],
    ['no card fingerprint', { cardFingerprints: [] }],
  ])('does not approve on %s', async (_label, overrides) => {
    h.attempts.mockResolvedValue([payment(overrides)]);

    const result = await autoApproveRiskReview(USER_ID, { rules: RULES, trigger: 'stripe/webhook', now: NOW });

    expect(result).toEqual({ outcome: 'skipped', reason: 'no_evidence' });
    expect(h.autoApprove).not.toHaveBeenCalled();
  });

  it('does not approve when any of the account payments was blocked by Radar', async () => {
    h.attempts.mockResolvedValue([payment(), payment({ paymentIntentId: 'pi_2', radarBlocked: true })]);

    const result = await autoApproveRiskReview(USER_ID, { rules: RULES, trigger: 'stripe/webhook', now: NOW });

    expect(result.outcome).toBe('skipped');
  });

  it.each([
    ['used by another account', 2],
    ['of unknown sharing (truncated count)', null],
  ])('does not approve on a card %s', async (_label, count) => {
    h.accountsForCard.mockResolvedValue(count);

    const result = await autoApproveRiskReview(USER_ID, { rules: RULES, trigger: 'stripe/webhook', now: NOW });

    expect(result.outcome).toBe('skipped');
  });

  it('waits until the payment has stood for minPaymentAgeHours', async () => {
    const rules = SignupRiskAutoApprovalSchema.parse({ settledPayment: { minPaymentAgeHours: 24 } });

    expect((await autoApproveRiskReview(USER_ID, { rules, trigger: 'stripe/webhook', now: NOW })).outcome).toBe(
      'skipped'
    );
    const later = new Date(NOW.getTime() + DAY_MS);
    expect((await autoApproveRiskReview(USER_ID, { rules, trigger: 'stripe/webhook', now: later })).outcome).toBe(
      'approved'
    );
  });

  it.each([
    ['banned', { isBanned: true }],
    ['disputed', { disputePending: true }],
    ['suspended', { moderation: { status: 'suspended' } }],
    ['forfeited after a refund or fraud warning', { signupGrant: { unlockForfeited: { cause: 'refund', at: NOW } } }],
  ])('never approves a %s account', async (_label, overrides) => {
    h.findById.mockResolvedValue(pendingUser(overrides));

    const result = await autoApproveRiskReview(USER_ID, { rules: RULES, trigger: 'stripe/webhook', now: NOW });

    expect(result).toEqual({ outcome: 'skipped', reason: 'blocked' });
    expect(h.attempts).not.toHaveBeenCalled();
  });

  it.each(['none', 'approved', 'banned'])('leaves a %s review alone', async reviewState => {
    h.findById.mockResolvedValue(pendingUser({ riskScore: { ...pendingUser().riskScore, reviewState } }));

    const result = await autoApproveRiskReview(USER_ID, { rules: RULES, trigger: 'stripe/webhook', now: NOW });

    expect(result).toEqual({ outcome: 'skipped', reason: 'not_pending' });
    expect(h.autoApprove).not.toHaveBeenCalled();
  });

  it('leaves an account an admin reopened to admins, even with a qualifying payment', async () => {
    h.findById.mockResolvedValue(pendingUser({ riskReviewReopenedAt: NOW }));

    const result = await autoApproveRiskReview(USER_ID, {
      rules: RULES,
      trigger: 'cron/signupGrantHeldRelease',
      now: NOW,
    });

    expect(result).toEqual({ outcome: 'skipped', reason: 'reopened' });
    expect(h.autoApprove).not.toHaveBeenCalled();
  });

  it('leaves an account with a signup tranche held for review to the admin approve path, which pays it', async () => {
    h.findById.mockResolvedValue(
      pendingUser({
        signupGrantAssessment: { band: 'review', status: 'evaluated' },
        signupGrant: { stage: 'signup', creditsReleased: 0, signupCredits: 100 },
      })
    );

    const result = await autoApproveRiskReview(USER_ID, { rules: RULES, trigger: 'stripe/webhook', now: NOW });

    expect(result).toEqual({ outcome: 'skipped', reason: 'grant_held' });
    expect(h.autoApprove).not.toHaveBeenCalled();
  });

  it('writes no audit entry when a concurrent decision already moved the review', async () => {
    h.autoApprove.mockResolvedValue(false);

    const result = await autoApproveRiskReview(USER_ID, { rules: RULES, trigger: 'stripe/webhook', now: NOW });

    expect(result).toEqual({ outcome: 'skipped', reason: 'not_pending' });
    expect(h.record).not.toHaveBeenCalled();
  });

  it('propagates an audit failure so the approval rolls back', async () => {
    h.record.mockRejectedValue(new Error('audit down'));

    await expect(autoApproveRiskReview(USER_ID, { rules: RULES, trigger: 'stripe/webhook', now: NOW })).rejects.toThrow(
      'audit down'
    );
  });
});

describe('autoApproveRiskReview: quiet account', () => {
  it('is off by default', async () => {
    h.attempts.mockResolvedValue([]);

    const result = await autoApproveRiskReview(USER_ID, { rules: RULES, trigger: 'stripe/webhook', now: NOW });

    expect(result.outcome).toBe('skipped');
    expect(h.openDetections).not.toHaveBeenCalled();
  });

  it('approves an old, borderline, unrescored account with no open detection when enabled', async () => {
    const result = await autoApproveRiskReview(USER_ID, {
      rules: QUIET_ONLY,
      trigger: 'cron/signupGrantHeldRelease',
      now: NOW,
    });

    expect(result).toEqual({ outcome: 'approved', policy: 'quiet_account' });
    expect(h.openDetections).toHaveBeenCalledWith(USER_ID);
  });

  it.each([
    ['too young', { createdAt: new Date(NOW.getTime() - 3 * DAY_MS) }],
    ['scoring above maxScore', { riskScore: { ...pendingUser().riskScore, score: 80 } }],
    ['rescored recently', { riskScore: { ...pendingUser().riskScore, computedAt: new Date(NOW.getTime() - DAY_MS) } }],
  ])('does not approve an account %s', async (_label, overrides) => {
    h.findById.mockResolvedValue(pendingUser(overrides));

    const result = await autoApproveRiskReview(USER_ID, {
      rules: QUIET_ONLY,
      trigger: 'cron/signupGrantHeldRelease',
      now: NOW,
    });

    expect(result.outcome).toBe('skipped');
  });

  it('does not approve an account named in an open shadow detection', async () => {
    h.openDetections.mockResolvedValue(1);

    const result = await autoApproveRiskReview(USER_ID, {
      rules: QUIET_ONLY,
      trigger: 'cron/signupGrantHeldRelease',
      now: NOW,
    });

    expect(result.outcome).toBe('skipped');
  });
});

describe('autoApproveRiskReviewAfterPayment', () => {
  it('does nothing for an account that is not pending', async () => {
    h.findById.mockResolvedValue(pendingUser({ riskScore: { ...pendingUser().riskScore, reviewState: 'none' } }));

    await autoApproveRiskReviewAfterPayment(USER_ID, logger as never);

    expect(h.settings).not.toHaveBeenCalled();
    expect(h.autoApprove).not.toHaveBeenCalled();
  });

  it('respects the settledPayment switch', async () => {
    h.settings.mockResolvedValue({ signupRiskAutoApproval: { settledPayment: { enabled: false } } });

    await autoApproveRiskReviewAfterPayment(USER_ID, logger as never);

    expect(h.autoApprove).not.toHaveBeenCalled();
  });

  it('never throws, so a failure cannot fail the webhook delivery', async () => {
    // The payment trigger runs on the wall clock, so the payment must predate it.
    h.attempts.mockResolvedValue([payment({ createdAt: new Date(Date.now() - 60_000) })]);
    h.autoApprove.mockRejectedValue(new Error('db down'));

    await expect(autoApproveRiskReviewAfterPayment(USER_ID, logger as never)).resolves.toBeUndefined();
    expect(h.autoApprove).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('sweepRiskReviewAutoApprovals', () => {
  it('walks the pending queue in pages and counts approvals and failures', async () => {
    const other = '2'.repeat(24);
    h.pendingIds.mockResolvedValueOnce([USER_ID, other]).mockResolvedValueOnce([]);
    h.findById.mockImplementation(async (id: string) => pendingUser({ id }));
    h.autoApprove.mockImplementation(async (id: string) => {
      if (id === other) throw new Error('write conflict');
      return true;
    });

    const result = await sweepRiskReviewAutoApprovals(logger, { maxUsers: 10, pageSize: 2, now: NOW });

    expect(result).toEqual({ scanned: 2, approved: 1, failed: 1 });
    expect(h.pendingIds).toHaveBeenNthCalledWith(2, { afterId: other, limit: 2 });
  });

  it('turns both rules off when the stored setting no longer parses', async () => {
    h.settings.mockResolvedValue({ signupRiskAutoApproval: { settledPayment: { enabled: 'yes' } } });

    const result = await sweepRiskReviewAutoApprovals(logger, { maxUsers: 10, now: NOW });

    expect(result).toEqual({ scanned: 0, approved: 0, failed: 0 });
    expect(h.pendingIds).not.toHaveBeenCalled();
  });

  it('applies the defaults when nothing is stored', async () => {
    h.pendingIds.mockResolvedValueOnce([USER_ID]).mockResolvedValueOnce([]);
    h.attempts.mockResolvedValue([payment({ createdAt: new Date(NOW.getTime() - 60_000) })]);

    const result = await sweepRiskReviewAutoApprovals(logger, { maxUsers: 10, now: NOW });

    expect(result).toEqual({ scanned: 1, approved: 1, failed: 0 });
  });

  it('reads nothing when both rules are off', async () => {
    h.settings.mockResolvedValue({ signupRiskAutoApproval: { settledPayment: { enabled: false } } });

    const result = await sweepRiskReviewAutoApprovals(logger, { maxUsers: 10, now: NOW });

    expect(result).toEqual({ scanned: 0, approved: 0, failed: 0 });
    expect(h.pendingIds).not.toHaveBeenCalled();
  });
});
