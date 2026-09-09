import { describe, expect, it } from 'vitest';
import {
  periodKeyForClock,
  periodKeyForLakeBudget,
  periodKeyForRun,
  periodKeyForWindow,
  SPEND_NOTIFY_WINDOW_MS,
} from './spendNotificationKeys';

describe('spendNotificationKeys', () => {
  it('periodKeyForWindow is exact and changes when the window rolls', () => {
    const a = new Date('2026-01-01T00:00:00.000Z');
    const b = new Date('2026-01-01T01:00:00.000Z');
    expect(periodKeyForWindow(a)).toBe('w:2026-01-01T00:00:00.000Z');
    expect(periodKeyForWindow(a)).not.toBe(periodKeyForWindow(b));
  });

  it('periodKeyForRun is scoped to the batch', () => {
    expect(periodKeyForRun('batch-1')).toBe('run:batch-1');
    expect(periodKeyForRun('batch-1')).not.toBe(periodKeyForRun('batch-2'));
  });

  it('periodKeyForLakeBudget re-arms when the budget value changes', () => {
    expect(periodKeyForLakeBudget(100_000_000)).toBe('lake:100000000');
    expect(periodKeyForLakeBudget(100_000_000)).not.toBe(periodKeyForLakeBudget(150_000_000));
  });

  it('periodKeyForClock buckets by the notify window and changes across a bucket boundary', () => {
    const t0 = new Date(0);
    const withinBucket = new Date(SPEND_NOTIFY_WINDOW_MS - 1);
    const nextBucket = new Date(SPEND_NOTIFY_WINDOW_MS);
    expect(periodKeyForClock(t0)).toBe(periodKeyForClock(withinBucket));
    expect(periodKeyForClock(t0)).not.toBe(periodKeyForClock(nextBucket));
  });
});
