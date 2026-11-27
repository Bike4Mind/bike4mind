import { describe, it, expect } from 'vitest';
import type { SpendTimelineRow } from '@bike4mind/common';
import {
  bucketKey,
  ceilToBucket,
  floorToBucket,
  isSpike,
  lookbackStart,
  median,
  normalizeProvider,
  shapeTimeline,
} from './shapeTimeline';

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const row = (bucket: string, key: string, costUsd: number): SpendTimelineRow => ({ bucket, key, costUsd, requests: 1 });

describe('bucket helpers', () => {
  it('floors, ceils and keys UTC buckets', () => {
    const at = new Date('2026-11-10T05:30:00Z');
    expect(floorToBucket(at, 'day').toISOString()).toBe('2026-11-10T00:00:00.000Z');
    expect(ceilToBucket(at, 'day').toISOString()).toBe('2026-11-11T00:00:00.000Z');
    expect(ceilToBucket(day('2026-11-10'), 'day').toISOString()).toBe('2026-11-10T00:00:00.000Z');
    expect(floorToBucket(at, 'hour').toISOString()).toBe('2026-11-10T05:00:00.000Z');
    expect(bucketKey(day('2026-11-10'), 'day')).toBe('2026-11-10');
    expect(bucketKey(new Date('2026-11-10T05:00:00Z'), 'hour')).toBe('2026-11-10T05');
  });

  it('looks back the longer of the range and the baseline window', () => {
    expect(lookbackStart(day('2026-11-10'), day('2026-11-12'), 'day').toISOString()).toBe('2026-11-03T00:00:00.000Z');
    expect(lookbackStart(day('2026-11-01'), day('2026-11-15'), 'day').toISOString()).toBe('2026-10-18T00:00:00.000Z');
  });

  it('computes medians and folds providers', () => {
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(normalizeProvider('Anthropic')).toBe('anthropic');
    expect(normalizeProvider('bedrock')).toBe('bedrock');
    expect(normalizeProvider('gemini')).toBe('other');
  });
});

describe('isSpike', () => {
  it('flags any bucket at or above the floor when there is no baseline', () => {
    expect(isSpike(1, 0)).toBe(true);
    expect(isSpike(0.99, 0)).toBe(false);
  });

  it('needs more than 1.5x a real baseline', () => {
    expect(isSpike(15, 10)).toBe(false);
    expect(isSpike(15.01, 10)).toBe(true);
  });
});

describe('shapeTimeline', () => {
  it('fills empty buckets, computes the baseline from history, flags spikes and aligns the previous period', () => {
    // A $10/day history, then a $30 day inside a 2-day window.
    const history = ['03', '04', '05', '06', '07', '08', '09'].map(d => row(`2026-11-${d}`, 'anthropic', 10));
    const { buckets, seriesKeys } = shapeTimeline({
      rows: [...history, row('2026-11-10', 'anthropic', 20), row('2026-11-10', 'openai', 10)],
      from: day('2026-11-10'),
      to: day('2026-11-12'),
      bucket: 'day',
      splitBy: 'provider',
    });

    expect(seriesKeys).toEqual(['anthropic', 'openai']);
    expect(buckets).toEqual([
      {
        start: '2026-11-10T00:00:00.000Z',
        totalUsd: 30,
        series: { anthropic: 20, openai: 10 },
        baselineUsd: 10,
        isSpike: true,
        previousUsd: 10,
      },
      {
        start: '2026-11-11T00:00:00.000Z',
        totalUsd: 0,
        series: {},
        // Window now holds the $30 day plus six $10 days.
        baselineUsd: 10,
        isSpike: false,
        previousUsd: 10,
      },
    ]);
  });

  it('does not flag sub-dollar swings as spikes', () => {
    const { buckets } = shapeTimeline({
      rows: [row('2026-11-10', 'anthropic', 0.5)],
      from: day('2026-11-10'),
      to: day('2026-11-11'),
      bucket: 'day',
      splitBy: 'provider',
    });
    expect(buckets[0].isSpike).toBe(false);
  });

  it('folds series beyond the cap into other, keeping the costliest', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row('2026-11-10', `model-${i}`, i + 1));
    const { seriesKeys, buckets } = shapeTimeline({
      rows,
      from: day('2026-11-10'),
      to: day('2026-11-11'),
      bucket: 'day',
      splitBy: 'model',
    });
    expect(seriesKeys).toHaveLength(8);
    expect(seriesKeys[0]).toBe('model-9');
    expect(seriesKeys.at(-1)).toBe('other');
    // model-0..model-2 (1 + 2 + 3) fold into other.
    expect(buckets[0].series.other).toBe(6);
    expect(buckets[0].totalUsd).toBe(55);
  });

  it('keeps lookback rows out of the series while counting them in the baseline', () => {
    const { seriesKeys } = shapeTimeline({
      rows: [row('2026-11-09T23', 'gemini', 5), row('2026-11-10T00', 'anthropic', 1)],
      from: new Date('2026-11-10T00:00:00Z'),
      to: new Date('2026-11-10T02:00:00Z'),
      bucket: 'hour',
      splitBy: 'provider',
    });
    expect(seriesKeys).toEqual(['anthropic']);
  });
});
