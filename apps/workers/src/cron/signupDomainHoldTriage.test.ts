import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignupDomainReview } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  listPending: vi.fn(),
  autoConfirm: vi.fn(),
  getSettingsMap: vi.fn(),
  recordAdminAction: vi.fn(),
  runAssessments: vi.fn(),
  assessmentDeps: vi.fn(),
  runAgeRecheck: vi.fn(),
}));

vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://x/%STAGE%' } }));
vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn(),
  adminAuditLogRepository: {},
  adminSettingsRepository: {},
  signupDomainReviewRepository: { listPending: h.listPending, autoConfirm: h.autoConfirm },
  signupProtectionRepository: {},
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/services', () => ({
  adminAuditService: { recordAdminAction: h.recordAdminAction },
  userService: { getDomainIntel: vi.fn() },
}));
vi.mock('./signupDomainAgeRecheck', () => ({ runSignupDomainAgeRecheck: h.runAgeRecheck }));
vi.mock('@server/security/signupDomainHoldAssessment/signupDomainHoldAssessment', () => ({
  runSignupDomainHoldAssessments: h.runAssessments,
  defaultSignupDomainHoldAssessmentDeps: h.assessmentDeps,
}));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: h.getSettingsMap,
  getSettingsValue: (key: string, settings: Record<string, unknown>, fallback: unknown) => settings[key] ?? fallback,
}));

import {
  handler,
  runSignupDomainHoldTriage,
  TRIAGE_BATCH_LIMIT,
  type SignupDomainHoldTriageDeps,
} from './signupDomainHoldTriage';

const now = new Date('2026-03-01T00:00:00Z');
const hold = (domain: string): SignupDomainReview => ({
  domain,
  status: 'held_pending_review',
  reason: 'disposable-aggregate',
  triggeredAt: new Date('2026-02-28'),
  cohortUserIds: ['user-1'],
  sampleEmails: [`a@${domain}`],
  signupCount: 1,
});

const makeDeps = (overrides: Partial<SignupDomainHoldTriageDeps> = {}) => {
  // The fake transaction discards the confirm when the audit write throws, like the real one.
  const confirmed: string[] = [];
  const deps: SignupDomainHoldTriageDeps = {
    holds: {
      listPending: vi.fn().mockResolvedValue([hold('one.test'), hold('two.test')]),
      autoConfirm: vi.fn().mockImplementation(async (domain: string) => {
        confirmed.push(domain);
        return true;
      }),
    },
    isRuleEnabled: vi.fn().mockResolvedValue(true),
    inTransaction: async fn => {
      const before = confirmed.length;
      try {
        return await fn();
      } catch (error) {
        confirmed.splice(before);
        throw error;
      }
    },
    recordAudit: vi.fn().mockResolvedValue(null),
    now: () => now,
    logger: { info: vi.fn(), error: vi.fn() },
    ...overrides,
  };
  return { deps, confirmed };
};

describe('runSignupDomainHoldTriage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('confirms pending disposable-aggregate holds and audits each as a system action', async () => {
    const { deps, confirmed } = makeDeps();
    const result = await runSignupDomainHoldTriage(deps);

    expect(result).toEqual({ status: 'ran', considered: 2, confirmed: 2, skipped: 0, failed: 0 });
    expect(deps.holds.listPending).toHaveBeenCalledWith('disposable-aggregate', TRIAGE_BATCH_LIMIT);
    expect(deps.holds.autoConfirm).toHaveBeenCalledWith(
      'one.test',
      'disposable-aggregate',
      'disposable-aggregate-rule',
      now
    );
    expect(confirmed).toEqual(['one.test', 'two.test']);
    expect(deps.recordAudit).toHaveBeenCalledTimes(2);
    expect(deps.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'signup_domain_hold.auto_confirmed',
        actor: expect.objectContaining({ kind: 'system', wasAdmin: false }),
        target: expect.objectContaining({ kind: 'system', displayName: 'one.test' }),
        context: expect.objectContaining({ source: 'worker' }),
        changes: [{ field: 'status', before: 'held_pending_review', after: 'blocked' }],
        occurredAt: now,
      })
    );
    const [auditInput] = vi.mocked(deps.recordAudit).mock.calls[0];
    expect(auditInput.actor.userId).toBeUndefined();
  });

  it('does nothing when the setting is off', async () => {
    const { deps } = makeDeps({ isRuleEnabled: vi.fn().mockResolvedValue(false) });
    expect(await runSignupDomainHoldTriage(deps)).toEqual({ status: 'disabled' });
    expect(deps.holds.listPending).not.toHaveBeenCalled();
    expect(deps.holds.autoConfirm).not.toHaveBeenCalled();
    expect(deps.recordAudit).not.toHaveBeenCalled();
  });

  it('writes no audit entry for a hold an admin decided first', async () => {
    const { deps } = makeDeps();
    vi.mocked(deps.holds.autoConfirm).mockResolvedValueOnce(false);
    const result = await runSignupDomainHoldTriage(deps);
    expect(result).toMatchObject({ confirmed: 1, skipped: 1 });
    expect(deps.recordAudit).toHaveBeenCalledTimes(1);
  });

  it('rolls back a confirm whose audit entry fails and carries on with the rest', async () => {
    const { deps, confirmed } = makeDeps();
    vi.mocked(deps.recordAudit).mockRejectedValueOnce(new Error('audit down'));
    const result = await runSignupDomainHoldTriage(deps);
    expect(result).toMatchObject({ confirmed: 1, failed: 1 });
    expect(confirmed).toEqual(['two.test']);
    expect(deps.logger.error).toHaveBeenCalledWith(
      '[signupDomainHoldTriage] auto-confirm failed',
      expect.objectContaining({ domain: 'one.test' })
    );
  });
});

describe('signupDomainHoldTriage handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.listPending.mockResolvedValue([hold('one.test')]);
    h.autoConfirm.mockResolvedValue(true);
    h.recordAdminAction.mockResolvedValue(null);
    h.assessmentDeps.mockImplementation((_logger: unknown, shouldStop: () => boolean) => ({ shouldStop }));
    h.runAssessments.mockResolvedValue({ status: 'skipped', reason: 'disabled' });
    h.runAgeRecheck.mockResolvedValue({ looked: 0, failed: 0, marked: 0 });
  });

  it('reads the setting fresh and stops the rule when an operator turned it off', async () => {
    h.getSettingsMap.mockResolvedValue({ autoConfirmDisposableAggregateHolds: false });
    expect(await handler()).toEqual({
      status: 'disabled',
      assessment: { status: 'skipped', reason: 'disabled' },
      ageRecheck: { looked: 0, failed: 0, marked: 0 },
    });
    expect(h.getSettingsMap).toHaveBeenCalledWith(expect.anything(), {
      skipCache: true,
      names: ['autoConfirmDisposableAggregateHolds'],
    });
    expect(h.listPending).not.toHaveBeenCalled();
  });

  it('defaults on and fails the run when a hold could not be confirmed, so the alarm sees it', async () => {
    h.getSettingsMap.mockResolvedValue({});
    h.autoConfirm.mockRejectedValue(new Error('write conflict'));
    await expect(handler()).rejects.toThrow('1 of 1 holds failed');
    expect(h.listPending).toHaveBeenCalledWith('disposable-aggregate', TRIAGE_BATCH_LIMIT);
  });

  it('runs the advisory assessment after the rule, stopping a minute before the Lambda timeout', async () => {
    h.getSettingsMap.mockResolvedValue({});
    const assessment = { status: 'ran', considered: 1, confirmed: 1, recorded: 0, failed: 0, errors: 0, skipped: {} };
    h.runAssessments.mockResolvedValue(assessment);
    const context = { getRemainingTimeInMillis: vi.fn().mockReturnValue(30_000) };
    expect(await handler(undefined, context)).toMatchObject({ status: 'ran', confirmed: 1, assessment });
    const [, shouldStop] = h.assessmentDeps.mock.calls[0];
    expect(shouldStop()).toBe(true);
    context.getRemainingTimeInMillis.mockReturnValue(120_000);
    expect(shouldStop()).toBe(false);
  });

  it('fails the run when an assessment hit an unexpected error', async () => {
    h.getSettingsMap.mockResolvedValue({});
    h.runAssessments.mockResolvedValue({
      status: 'ran',
      considered: 2,
      confirmed: 0,
      recorded: 1,
      failed: 0,
      errors: 1,
      skipped: {},
    });
    await expect(handler()).rejects.toThrow('1 of 2 assessments failed');
  });

  it('runs the young-domain age recheck even with the rule off, and fails the run when a lookup failed', async () => {
    h.getSettingsMap.mockResolvedValue({ autoConfirmDisposableAggregateHolds: false });
    h.runAgeRecheck.mockResolvedValue({ looked: 1, failed: 2, marked: 0 });
    await expect(handler()).rejects.toThrow('2 young-domain age rechecks failed');
    expect(h.runAgeRecheck).toHaveBeenCalledTimes(1);
  });

  it('reads the young-domain age from settings for the recheck, defaulting to 30 days', async () => {
    h.getSettingsMap.mockResolvedValue({});
    await handler();
    const [deps] = h.runAgeRecheck.mock.calls[0];
    expect(await deps.youngerThanDays()).toBe(30);
    h.getSettingsMap.mockResolvedValue({ holdSignupsFromDomainsYoungerThanDays: 14 });
    expect(await deps.youngerThanDays()).toBe(14);
  });
});
