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
  return {
    claimed,
    touched,
    claimDedup,
    deleteByKey,
    record,
    cacheRepository: spy('cacheRepository', { claimDedup, deleteByKey }),
    shadowDetectionRepository: spy('shadowDetectionRepository', { record }),
  };
});

// Only these two exports exist: reaching for a user, credit or key repository would throw on import.
vi.mock('@bike4mind/database', () => ({
  cacheRepository: mocks.cacheRepository,
  shadowDetectionRepository: mocks.shadowDetectionRepository,
}));

import {
  buildYoungAccountSpendShadowDetection,
  recordYoungAccountSpendShadowDetections,
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
};
const spenderB = {
  userId: 'user-b',
  creditsSpent: 3000,
  accountCreatedAt: new Date('2026-10-20T11:00:00Z'),
  stripeCustomerId: 'cus_b',
};
const summary = { totalCredits: 9000, accountCount: 2, topSpenders: [spenderA, spenderB] };
const logger = { error: vi.fn() };

const record = () => recordYoungAccountSpendShadowDetections({ summary, thresholds, window, logger });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claimed.clear();
  mocks.touched.length = 0;
});

describe('young-account spend shadow detection evidence', () => {
  it('records a valid contain detection for one account with its own and the fleet signals', () => {
    const detection = buildYoungAccountSpendShadowDetection({
      spender: spenderA,
      rank: 1,
      summary,
      thresholds,
      window,
    });

    expect(detection).toEqual({
      detector: 'youngAccountSpend',
      policyVersion: YOUNG_ACCOUNT_SPEND_POLICY_VERSION,
      wouldAction: 'contain',
      summary:
        '6,000 credits in 60 minutes from a 30-hour-old account (#1 of 2 young accounts, 9,000 credits in total)',
      userIds: ['user-a'],
      network: null,
      signals: [
        { key: 'accountCredits', label: expect.any(String), observed: 6000, threshold: null },
        { key: 'spendRank', label: expect.any(String), observed: 1, threshold: null },
        { key: 'accountAgeHours', label: expect.any(String), observed: 30, threshold: null },
        { key: 'hasStripeCustomer', label: expect.any(String), observed: 0, threshold: null },
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

  it('marks an account that reached Stripe checkout', () => {
    const detection = buildYoungAccountSpendShadowDetection({
      spender: spenderB,
      rank: 2,
      summary,
      thresholds,
      window,
    });
    expect(detection.signals.find(signal => signal.key === 'hasStripeCustomer')?.observed).toBe(1);
    expect(detection.signals.find(signal => signal.key === 'spendRank')?.observed).toBe(2);
  });
});

describe('young-account spend shadow detection recording', () => {
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
      new Set(['cacheRepository.claimDedup', 'cacheRepository.deleteByKey', 'shadowDetectionRepository.record'])
    );
  });
});
