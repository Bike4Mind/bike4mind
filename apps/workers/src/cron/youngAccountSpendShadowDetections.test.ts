import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shadowDetectionItemSchema } from '@bike4mind/common';

const mocks = vi.hoisted(() => {
  const claimed = new Set<string>();
  const touched: string[] = [];
  // Records every member the recorder reaches for, so the test can prove it only ever writes a record.
  const spy = <T extends Record<string, unknown>>(name: string, target: T): T =>
    new Proxy(target, {
      get(object, property, receiver) {
        if (typeof property === 'string') touched.push(`${name}.${property}`);
        return Reflect.get(object, property, receiver);
      },
    });
  const claimDedup = vi.fn(async (key: string) => {
    if (claimed.has(key)) return { claimed: false };
    claimed.add(key);
    return { claimed: true };
  });
  const deleteByKey = vi.fn(async (key: string) => {
    claimed.delete(key);
  });
  const record = vi.fn(async () => 'detection-id');
  const findAccountRiskProfiles = vi.fn(
    async (): Promise<{ id: string; email: string | null; signupIp: string | null; signupJa4: string | null }[]> => []
  );
  return {
    findAccountRiskProfiles,
    userRepository: spy('userRepository', { findAccountRiskProfiles }),
    claimed,
    touched,
    claimDedup,
    deleteByKey,
    record,
    cacheRepository: spy('cacheRepository', { claimDedup, deleteByKey }),
    shadowDetectionRepository: spy('shadowDetectionRepository', { record }),
  };
});

// Only these exports exist, and the user repository only offers a read: reaching for a credit or key
// repository, or a user write, would throw.
vi.mock('@bike4mind/database', () => ({
  cacheRepository: mocks.cacheRepository,
  shadowDetectionRepository: mocks.shadowDetectionRepository,
  userRepository: mocks.userRepository,
}));

import {
  buildYoungAccountSpendShadowDetection,
  recordYoungAccountSpendShadowDetections,
  spenderCohorts,
  youngAccountSpendDedupeKey,
  YOUNG_ACCOUNT_SPEND_POLICY_VERSION,
} from './youngAccountSpendShadowDetections';

const window = { start: new Date('2026-10-26T10:00:00Z'), end: new Date('2026-10-26T11:00:00Z') };
const thresholds = { credits: 5000, accounts: 25 };
const spenderA = {
  userId: 'user-a',
  creditsSpent: 6000,
  accountCreatedAt: new Date('2026-10-25T05:00:00Z'),
  stripeCustomerId: null,
  email: 'a@example.com',
};
const spenderB = {
  userId: 'user-b',
  creditsSpent: 3000,
  accountCreatedAt: new Date('2026-10-20T11:00:00Z'),
  stripeCustomerId: 'cus_b',
  email: null,
};
const summary = { totalCredits: 9000, accountCount: 2, topSpenders: [spenderA, spenderB] };
const logger = { error: vi.fn() };

const record = () => recordYoungAccountSpendShadowDetections({ summary, thresholds, window, logger });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claimed.clear();
  mocks.touched.length = 0;
});

const linkedCohort = { linkedUserIds: ['user-b'], kinds: ['mailbox' as const], linkedCredits: 9000 };
const unlinkedCohort = { linkedUserIds: [], kinds: [], linkedCredits: 6000 };

describe('young-account spend shadow detection evidence', () => {
  it('records a valid contain detection for a linked account with its own, cohort and fleet signals', () => {
    const detection = buildYoungAccountSpendShadowDetection({
      spender: spenderA,
      rank: 1,
      summary,
      thresholds,
      window,
      cohort: linkedCohort,
    });

    expect(detection).toEqual({
      detector: 'youngAccountSpend',
      policyVersion: YOUNG_ACCOUNT_SPEND_POLICY_VERSION,
      wouldAction: 'contain',
      summary:
        '6,000 credits in 60 minutes from a 30-hour-old account (#1 by spend of 2 young accounts; ' +
        'linked to 1 other listed spender by mailbox, 9,000 credits together)',
      userIds: ['user-a'],
      network: null,
      signals: [
        { key: 'accountCredits', label: expect.any(String), observed: 6000, threshold: null },
        { key: 'spendRank', label: expect.any(String), observed: 1, threshold: null },
        { key: 'accountAgeHours', label: expect.any(String), observed: 30, threshold: null },
        { key: 'hasStripeCustomer', label: expect.any(String), observed: 0, threshold: null },
        { key: 'linkedSpenders', label: expect.any(String), observed: 1, threshold: null },
        { key: 'linkedSpenderCredits', label: expect.any(String), observed: 9000, threshold: null },
        { key: 'linkedBy_mailbox', label: expect.any(String), observed: 1, threshold: null },
        { key: 'youngAccountCredits', label: expect.any(String), observed: 9000, threshold: 5000 },
        { key: 'youngAccountCount', label: expect.any(String), observed: 2, threshold: 25 },
      ],
      windowMinutes: 60,
      group: null,
      payment: null,
      detectedAt: window.end,
    });
    // The record must satisfy the shared contract the Detections page parses.
    expect(() =>
      shadowDetectionItemSchema.parse({ ...detection, id: 'x', verdict: null, verdicts: [], revision: 0 })
    ).not.toThrow();
  });

  it('drops the fleet totals from an account unrelated to the other spenders', () => {
    const detection = buildYoungAccountSpendShadowDetection({
      spender: spenderA,
      rank: 1,
      summary,
      thresholds,
      window,
      cohort: unlinkedCohort,
    });
    expect(detection.summary).toBe(
      '6,000 credits in 60 minutes from a 30-hour-old account (#1 by spend of 2 young accounts; ' +
        'not linked to the other listed spenders)'
    );
    expect(detection.summary).not.toContain('in total');
    expect(detection.signals.map(signal => signal.key)).toEqual([
      'accountCredits',
      'spendRank',
      'accountAgeHours',
      'hasStripeCustomer',
      'linkedSpenders',
    ]);
    expect(detection.signals.find(signal => signal.key === 'linkedSpenders')?.observed).toBe(0);
  });

  it('says the links are unknown, without fleet totals, when the link facts could not be read', () => {
    const detection = buildYoungAccountSpendShadowDetection({
      spender: spenderA,
      rank: 1,
      summary,
      thresholds,
      window,
      cohort: null,
    });
    expect(detection.summary).toContain('links to the other listed spenders unknown');
    expect(detection.signals.find(signal => signal.key === 'linkedSpenders')?.observed).toBeNull();
    expect(detection.signals.some(signal => signal.key === 'youngAccountCredits')).toBe(false);
  });

  it('marks an account that reached Stripe checkout', () => {
    const detection = buildYoungAccountSpendShadowDetection({
      spender: spenderB,
      rank: 2,
      summary,
      thresholds,
      window,
      cohort: unlinkedCohort,
    });
    expect(detection.signals.find(signal => signal.key === 'hasStripeCustomer')?.observed).toBe(1);
    expect(detection.signals.find(signal => signal.key === 'spendRank')?.observed).toBe(2);
  });
});

describe('spenderCohorts', () => {
  it('links spenders by signup facts and leaves unrelated spenders in a cohort of one', () => {
    const spenderC = { ...spenderB, userId: 'user-c', creditsSpent: 1000, email: 'c@gmail.com' };
    const cohorts = spenderCohorts(
      [spenderA, spenderB, spenderC],
      [
        { id: 'user-a', email: 'farm+x7k2q9@outlook.com', signupIp: null, signupJa4: null },
        { id: 'user-b', email: 'farm+p3m8z1@outlook.com', signupIp: null, signupJa4: null },
        { id: 'user-c', email: 'c@gmail.com', signupIp: '198.51.100.4', signupJa4: null },
      ]
    );
    expect(cohorts.get('user-a')).toEqual({ linkedUserIds: ['user-b'], kinds: ['mailbox'], linkedCredits: 9000 });
    expect(cohorts.get('user-c')).toEqual({ linkedUserIds: [], kinds: [], linkedCredits: 1000 });
  });
});

describe('young-account spend shadow detection recording', () => {
  it('records linked spenders with the cohort and unlinked ones without the fleet totals', async () => {
    mocks.findAccountRiskProfiles.mockResolvedValueOnce([
      { id: 'user-a', email: 'a@example.com', signupIp: '198.51.100.4', signupJa4: null },
      { id: 'user-b', email: null, signupIp: '198.51.100.4', signupJa4: null },
    ]);
    await record();
    expect(mocks.findAccountRiskProfiles).toHaveBeenCalledWith(['user-a', 'user-b']);
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userIds: ['user-a'],
        signals: expect.arrayContaining([expect.objectContaining({ key: 'linkedBy_signupIp' })]),
      })
    );

    vi.clearAllMocks();
    mocks.claimed.clear();
    await record();
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userIds: ['user-a'],
        signals: expect.not.arrayContaining([expect.objectContaining({ key: 'youngAccountCredits' })]),
      })
    );
  });

  it('still records, with links unknown, when the link facts read fails', async () => {
    mocks.findAccountRiskProfiles.mockRejectedValueOnce(new Error('db down'));
    expect(await record()).toBe(2);
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ summary: expect.stringContaining('links to the other listed spenders unknown') })
    );
  });

  it('records one detection per listed account, claimed per account and window', async () => {
    expect(await record()).toBe(2);
    expect(mocks.record).toHaveBeenCalledTimes(2);
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ userIds: ['user-a'] }));
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ userIds: ['user-b'] }));
    expect(mocks.claimDedup).toHaveBeenCalledWith(
      'shadow-detection:young-account-spend:user-a:2026-10-26T11:00:00.000Z',
      { userId: 'user-a' },
      expect.any(Number)
    );
  });

  it('does not record the same account and window twice on a retried run', async () => {
    await record();
    mocks.record.mockClear();
    expect(await record()).toBe(0);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('records the same account again in the next window', async () => {
    await record();
    mocks.record.mockClear();
    const nextWindow = { start: window.end, end: new Date('2026-10-26T12:00:00Z') };
    expect(await recordYoungAccountSpendShadowDetections({ summary, thresholds, window: nextWindow, logger })).toBe(2);
    expect(youngAccountSpendDedupeKey('user-a', nextWindow)).not.toBe(youngAccountSpendDedupeKey('user-a', window));
  });

  it('releases the claim of a failed write so a retry of the same window records it, and never throws', async () => {
    mocks.record.mockRejectedValueOnce(new Error('write failed'));
    expect(await record()).toBe(1);
    expect(mocks.deleteByKey).toHaveBeenCalledExactlyOnceWith(youngAccountSpendDedupeKey('user-a', window));
    expect(logger.error).toHaveBeenCalledWith(
      'young-account spend shadow detection was not recorded',
      expect.objectContaining({ userId: 'user-a' })
    );

    mocks.record.mockClear();
    expect(await record()).toBe(1);
    expect(mocks.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ userIds: ['user-a'] }));
  });

  it('never throws when the claim itself fails, and releases nothing it did not win', async () => {
    mocks.claimDedup.mockRejectedValueOnce(new Error('cache unavailable'));
    await expect(record()).resolves.toBe(1);
    expect(mocks.deleteByKey).not.toHaveBeenCalled();
  });

  it('never throws when releasing a claim fails', async () => {
    mocks.record.mockRejectedValueOnce(new Error('write failed'));
    mocks.deleteByKey.mockRejectedValueOnce(new Error('cache unavailable'));
    await expect(record()).resolves.toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      'young-account spend shadow detection claim was not released',
      expect.anything()
    );
  });

  it('only claims and writes detections: no enforcement call is reachable', async () => {
    mocks.record.mockRejectedValueOnce(new Error('write failed'));
    await record();
    expect(new Set(mocks.touched)).toEqual(
      new Set([
        'userRepository.findAccountRiskProfiles',
        'cacheRepository.claimDedup',
        'cacheRepository.deleteByKey',
        'shadowDetectionRepository.record',
      ])
    );
  });
});
