import { describe, expect, it } from 'vitest';
import type { UsagePatternSignalsResult } from '@bike4mind/common';
import { setupMongoTest } from '../../__test__/utils';
import {
  USAGE_PATTERN_SIGNALS_RETENTION_SECONDS,
  UserUsagePatternSignals,
  userUsagePatternSignalsRepository,
} from './UserUsagePatternSignalsModel';

setupMongoTest();

const result = (score: number): UsagePatternSignalsResult => ({
  signals: [{ id: 'quickApiKey', value: 2, triggered: true, weight: score, explanation: 'synthetic' }],
  score,
  needsReview: score >= 50,
});

describe('UserUsagePatternSignalsRepository', () => {
  it('keeps one document per user, replaced by the latest result', async () => {
    await userUsagePatternSignalsRepository.upsertLatest('user-1', result(80), new Date('2026-01-01T00:00:00Z'));
    await userUsagePatternSignalsRepository.upsertLatest('user-1', result(10), new Date('2026-01-01T01:00:00Z'));

    expect(await UserUsagePatternSignals.countDocuments({ userId: 'user-1' })).toBe(1);
    const latest = await userUsagePatternSignalsRepository.findByUserId('user-1');
    expect(latest).toMatchObject({ score: 10, needsReview: false, computedAt: new Date('2026-01-01T01:00:00Z') });
    expect(latest?.signals[0]).toMatchObject({ id: 'quickApiKey', value: 2, triggered: true, weight: 10 });
  });

  it('marks a skipped user without a score and clears the marker once scored', async () => {
    await userUsagePatternSignalsRepository.markSkipped('user-2', 'paid', new Date('2026-01-01T00:00:00Z'));
    expect(await userUsagePatternSignalsRepository.findByUserId('user-2')).toMatchObject({
      skipped: 'paid',
      signals: [],
      score: 0,
      needsReview: false,
    });

    await userUsagePatternSignalsRepository.upsertLatest('user-2', result(80), new Date('2026-01-01T01:00:00Z'));
    const scored = await userUsagePatternSignalsRepository.findByUserId('user-2');
    expect(scored).toMatchObject({ score: 80, needsReview: true });
    expect(scored?.skipped).toBeUndefined();
  });

  it('declares a unique userId and a TTL on computedAt', async () => {
    await UserUsagePatternSignals.syncIndexes();
    const indexes = await UserUsagePatternSignals.collection.indexes();
    expect(indexes.find(i => i.key.userId === 1)?.unique).toBe(true);
    expect(indexes.find(i => i.key.computedAt === 1)?.expireAfterSeconds).toBe(USAGE_PATTERN_SIGNALS_RETENTION_SECONDS);
  });
});
