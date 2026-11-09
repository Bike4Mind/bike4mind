import { describe, expect, it, vi } from 'vitest';
import type { SignupDomainReview } from '@bike4mind/common';

vi.mock('@bike4mind/database', () => ({ signupDomainReviewRepository: {} }));

import {
  AGE_RECHECK_BATCH_LIMIT,
  AGE_RECHECK_RETRY_MS,
  runSignupDomainAgeRecheck,
  type SignupDomainAgeRecheckDeps,
} from './signupDomainAgeRecheck';

const now = new Date('2026-03-01T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const hold = (domain: string): SignupDomainReview => ({
  domain,
  status: 'held_pending_review',
  reason: 'young-domain (<30 days)',
  triggeredAt: new Date('2026-02-01'),
  cohortUserIds: [],
  sampleEmails: [],
  signupCount: 1,
});

const makeDeps = (overrides: Partial<SignupDomainAgeRecheckDeps> = {}) => {
  const holds = {
    listForAgeRecheck: vi.fn(async () => [hold('aged.test'), hold('rdap-down.test')]),
    recordDomainAgeCheck: vi.fn(async () => true),
    markAgedDomains: vi.fn(async () => 1),
  };
  const deps: SignupDomainAgeRecheckDeps = {
    holds,
    youngerThanDays: async () => 30,
    domainIntel: vi.fn(async (domain: string) =>
      domain === 'aged.test' ? { registeredAt: new Date('2026-01-01') } : { registeredAt: undefined }
    ),
    shouldStop: () => false,
    now: () => now,
    logger: { info: vi.fn(), error: vi.fn() },
    ...overrides,
  };
  return { deps, holds };
};

describe('runSignupDomainAgeRecheck', () => {
  it('records each lookup, then marks holds registered at least the configured days ago', async () => {
    const { deps, holds } = makeDeps();
    expect(await runSignupDomainAgeRecheck(deps)).toEqual({ looked: 2, failed: 0, marked: 1 });
    expect(holds.listForAgeRecheck).toHaveBeenCalledWith(
      new Date(now.getTime() - AGE_RECHECK_RETRY_MS),
      AGE_RECHECK_BATCH_LIMIT
    );
    expect(holds.recordDomainAgeCheck).toHaveBeenCalledWith('aged.test', now, new Date('2026-01-01'));
    // No registration date: only the attempt is stamped, so the lookup retries after the backoff.
    expect(holds.recordDomainAgeCheck).toHaveBeenCalledWith('rdap-down.test', now, undefined);
    expect(holds.markAgedDomains).toHaveBeenCalledWith(new Date(now.getTime() - 30 * DAY_MS), now);
  });

  it('only ever writes the age hint: it exposes no way to release or confirm a hold', async () => {
    const { deps, holds } = makeDeps();
    await runSignupDomainAgeRecheck(deps);
    expect(Object.keys(holds).sort()).toEqual(['listForAgeRecheck', 'markAgedDomains', 'recordDomainAgeCheck']);
  });

  it('counts a failed lookup and carries on with the rest', async () => {
    const { deps, holds } = makeDeps({
      domainIntel: vi.fn(async (domain: string) => {
        if (domain === 'aged.test') throw new Error('cache unavailable');
        return { registeredAt: new Date('2026-01-01') };
      }),
    });
    expect(await runSignupDomainAgeRecheck(deps)).toEqual({ looked: 1, failed: 1, marked: 1 });
    expect(holds.recordDomainAgeCheck).toHaveBeenCalledTimes(1);
    expect(deps.logger.error).toHaveBeenCalledWith(
      '[signupDomainAgeRecheck] lookup failed',
      expect.objectContaining({ domain: 'aged.test' })
    );
  });

  it('stops looking up near the Lambda timeout but still marks what is already known', async () => {
    const { deps, holds } = makeDeps({ shouldStop: () => true });
    expect(await runSignupDomainAgeRecheck(deps)).toEqual({ looked: 0, failed: 0, marked: 1 });
    expect(deps.domainIntel).not.toHaveBeenCalled();
    expect(holds.markAgedDomains).toHaveBeenCalledTimes(1);
  });

  it('treats any known registration date as aged when the age check is turned off', async () => {
    const { deps, holds } = makeDeps({ youngerThanDays: async () => 0 });
    await runSignupDomainAgeRecheck(deps);
    expect(holds.markAgedDomains).toHaveBeenCalledWith(now, now);
  });
});
