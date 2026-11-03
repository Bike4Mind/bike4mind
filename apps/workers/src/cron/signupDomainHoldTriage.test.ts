import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignupDomainReview } from '@bike4mind/common';

vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://x/%STAGE%' } }));
vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn(),
  adminAuditLogRepository: {},
  adminSettingsRepository: {},
  signupDomainReviewRepository: {},
  withTransaction: vi.fn(),
}));
vi.mock('@bike4mind/services', () => ({ adminAuditService: { recordAdminAction: vi.fn() } }));
vi.mock('@bike4mind/utils', () => ({ getSettingsMap: vi.fn(), getSettingsValue: vi.fn() }));

import {
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
