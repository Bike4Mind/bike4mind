import type { ISpendRollup } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { median, percentile, platformBaseline, scopeBaseline, windowSums } from './baselines';

const END = new Date('2026-10-30T12:00:00.000Z');
const rollup = (bucketStart: Date, credits: number, costUsd = 0): ISpendRollup => ({
  bucketStart,
  scopeType: 'User',
  scopeId: 'u1',
  credits,
  costUsd,
  creditsCharged: 0,
  requests: 1,
});
const minutesBefore = (minutes: number) => new Date(END.getTime() - minutes * 60_000);

describe('median', () => {
  it('is null for an empty list', () => expect(median([])).toBeNull());
  it('averages the middle pair for even counts', () => expect(median([4, 1, 3, 2])).toBe(2.5));
  it('picks the middle for odd counts', () => expect(median([5, 1, 3])).toBe(3));
});

describe('percentile', () => {
  it('uses nearest rank', () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(values, 95)).toBe(95);
  });
  it('is null for an empty list', () => expect(percentile([], 95)).toBeNull());
});

describe('windowSums', () => {
  it('yields 672 windows over 7 days, zero where buckets are missing', () => {
    const sums = windowSums([], END, 7, 'credits');
    expect(sums).toHaveLength(672);
    expect(sums.every(sum => sum === 0)).toBe(true);
  });

  it('sums the three buckets of a window and respects [start, end) boundaries', () => {
    const series = [
      rollup(minutesBefore(5), 1),
      rollup(minutesBefore(10), 2),
      rollup(minutesBefore(15), 4),
      rollup(minutesBefore(20), 8),
      rollup(END, 1000),
    ];
    const sums = windowSums(series, END, 1, 'credits');
    expect(sums[0]).toBe(7);
    expect(sums[1]).toBe(8);
  });

  it('reads the requested field', () => {
    expect(windowSums([rollup(minutesBefore(5), 1, 9)], END, 1, 'costUsd')[0]).toBe(9);
  });

  it('ignores buckets older than the span', () => {
    const sums = windowSums([rollup(minutesBefore(24 * 60 + 5), 50)], END, 1, 'credits');
    expect(sums.reduce((total, sum) => total + sum, 0)).toBe(0);
  });
});

describe('platformBaseline', () => {
  it('uses the same-slot median with at least 2 samples', () => {
    expect(platformBaseline([100, 200], [10, 20, 30])).toBe(150);
  });
  it('falls back to the trailing 24h median', () => expect(platformBaseline([100], [10, 20, 30])).toBe(20));
  it('is null with no history', () => expect(platformBaseline([], [])).toBeNull());
});

describe('scopeBaseline', () => {
  it('is 0 when empty', () => expect(scopeBaseline([])).toBe(0));
  it('is the p95 of the window sums', () => {
    expect(scopeBaseline(Array.from({ length: 100 }, (_, index) => index + 1))).toBe(95);
  });
});
