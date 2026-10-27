import { describe, expect, it } from 'vitest';
import {
  anomalyAlerts,
  anomalyMessages,
  compareMetric,
  comparisonWindow,
  createMetricAccumulator,
  DAY_MS,
  periodIndex,
  thresholdsSchema,
  type Metric,
} from './businessMetricAnomalies';

const metric = (current: number, previous = 100): Metric => ({
  name: 'requests:user',
  values: [current, previous, 90, 100, 110, 120, 130, 140],
  contributors: [],
});

describe('business metric comparisons', () => {
  it('uses a closed UTC day at midnight and equal elapsed days intraday', () => {
    const daily = comparisonWindow(new Date('2026-10-26T00:05:00Z'));
    expect(daily).toEqual({ end: new Date('2026-10-26T00:00:00Z'), duration: DAY_MS, mode: 'daily' });
    expect(periodIndex(new Date('2026-10-25T00:00:00Z'), daily)).toBe(0);
    expect(periodIndex(daily.end, daily)).toBeNull();
    const intraday = comparisonWindow(new Date('2026-10-26T12:05:00Z'));
    expect(periodIndex(new Date('2026-10-25T11:59:59Z'), intraday)).toBe(1);
    expect(periodIndex(new Date('2026-10-25T12:00:00Z'), intraday)).toBeNull();
    expect(periodIndex(new Date('2026-10-26T00:00:00Z'), intraday)).toBe(0);
    expect(periodIndex(new Date('2026-10-18T11:59:59Z'), intraday)).toBeNull();
  });

  it('alerts in both directions only above the relative threshold and at the absolute guard', () => {
    expect(compareMetric(metric(104), {})).toBeNull();
    expect(compareMetric(metric(105), { requests: { percent: 5, minimumDelta: 1 } })).toBeNull();
    expect(compareMetric(metric(106), {})).toBeNull();
    expect(compareMetric(metric(110), {})).toMatchObject({ delta: 10, percent: 10, median: 110 });
    expect(compareMetric(metric(90), {})).toMatchObject({ delta: -10, percent: -10 });
    expect(compareMetric(metric(11, 1), {})).toMatchObject({ delta: 10 });
  });

  it.each([
    ['spendUsd', 10, 5],
    ['credits', 1000, 100],
    ['payingSubscribers', 10, 2],
    ['revenueMinor', 10_000, 1000],
    ['requests:user', 100, 10],
  ])('pins the default absolute guard for %s at %d + %d', (name, previous, minimumDelta) => {
    const named = (current: number): Metric => ({ ...metric(current, previous), name });
    expect(compareMetric(named(previous + minimumDelta), {})).toMatchObject({ delta: minimumDelta });
    expect(compareMetric(named(previous - minimumDelta), {})).toMatchObject({ delta: -minimumDelta });
    expect(compareMetric(named(previous + minimumDelta - 0.01), {})).toBeNull();
    expect(compareMetric(named(previous - minimumDelta + 0.01), {})).toBeNull();
  });

  it('keeps the oldest comparison day and drops the first day beyond it', () => {
    const intraday = comparisonWindow(new Date('2026-10-26T12:05:00Z'));
    expect(periodIndex(new Date('2026-10-19T11:59:59Z'), intraday)).toBe(7);
    expect(periodIndex(new Date('2026-10-19T12:00:00Z'), intraday)).toBeNull();
    expect(periodIndex(new Date('2026-10-19T00:00:00Z'), intraday)).toBe(7);
    expect(periodIndex(new Date('2026-10-18T23:59:59Z'), intraday)).toBeNull();
    const daily = comparisonWindow(new Date('2026-10-26T00:05:00Z'));
    expect(periodIndex(new Date('2026-10-18T00:00:00Z'), daily)).toBe(7);
    expect(periodIndex(new Date('2026-10-17T23:59:59Z'), daily)).toBeNull();
  });

  it('handles zero and unavailable baselines without NaN or false subscriber alerts', () => {
    expect(compareMetric(metric(0, 0), {})).toBeNull();
    expect(compareMetric(metric(10, 0), {})).toMatchObject({ percent: null });
    expect(compareMetric({ ...metric(100), values: [100, null] }, {})).toBeNull();
  });

  it('validates overrides and supports provider and source specific thresholds', () => {
    expect(() => thresholdsSchema.parse({ requests: { percent: -1, minimumDelta: 10 } })).toThrow();
    expect(() => thresholdsSchema.parse({ requests: { minimumDelta: 0 } })).toThrow();
    expect(compareMetric(metric(110), { 'requests:user': { percent: 20, minimumDelta: 1 } })).toBeNull();
    expect(compareMetric(metric(110), { requests: { percent: 20, minimumDelta: 1 } })).toBeNull();
  });

  it('suppresses a one-subscriber change and tiny monetary receipts by default', () => {
    expect(compareMetric({ ...metric(2, 1), name: 'payingSubscribers' }, {})).toBeNull();
    expect(compareMetric({ ...metric(20, 10), name: 'revenueMinor:usd' }, {})).toBeNull();
  });

  it('zero fills prior days and sums contributors before selecting the top five', () => {
    const accumulator = createMetricAccumulator();
    accumulator.add('spendUsd', 0, 5, ['model:large', 'user:a']);
    accumulator.add('spendUsd', 0, 7, ['model:large', 'user:b']);
    accumulator.add('spendUsd', 1, 10, ['model:previous']);
    expect(accumulator.result()[0]).toMatchObject({
      values: [12, 10, 0, 0, 0, 0, 0, 0],
      contributors: expect.arrayContaining([{ label: 'model:large', value: 12 }]),
    });
    expect(() => accumulator.add('spendUsd', 0, NaN)).toThrow();
  });

  it('attributes changes to signed deltas, including contributors that dropped to zero', () => {
    const accumulator = createMetricAccumulator();
    accumulator.add('spendUsd', 0, 1000, ['user:steady']);
    accumulator.add('spendUsd', 1, 1000, ['user:steady']);
    accumulator.add('spendUsd', 0, 80, ['user:growing']);
    accumulator.add('spendUsd', 1, 20, ['user:growing']);
    accumulator.add('spendUsd', 1, 200, ['user:stopped']);
    accumulator.add('spendUsd', 2, 9000, ['user:older']);
    const metrics = accumulator.result();
    expect(metrics[0].contributors).toEqual(
      expect.arrayContaining([
        { label: 'user:steady', value: 0 },
        { label: 'user:growing', value: 60 },
        { label: 'user:stopped', value: -200 },
      ])
    );
    expect(metrics[0].contributors).not.toContainEqual(expect.objectContaining({ label: 'user:older' }));
    const message = anomalyMessages(metrics, comparisonWindow(new Date('2026-10-26T12:05:00Z')), {})[0];
    expect(message).toContain('Top contributors: user:stopped=-200.00');
    expect(message).not.toContain('user:steady');
    expect(message).not.toContain('user:growing');
  });

  it('ranks only contributors moving in the anomaly direction by the size of their change', () => {
    const contributors = [
      { label: 'user:opposing', value: -1000 },
      { label: 'user:small', value: 10 },
      { label: 'user:large', value: 100 },
      { label: 'user:steady', value: 0 },
    ];
    const message = anomalyMessages(
      [{ ...metric(200), contributors }],
      comparisonWindow(new Date('2026-10-26T12:05:00Z')),
      {}
    )[0];
    expect(message).toContain('Top contributors: user:large=+100.00, user:small=+10.00');
    expect(message).not.toContain('user:opposing');
    expect(message).not.toContain('user:steady');
  });

  it('carries stable metric identity and direction separately from presentation', () => {
    const window = comparisonWindow(new Date('2026-10-26T12:05:00Z'));
    expect(
      anomalyAlerts([metric(120), { ...metric(80), name: 'credits' }], window, {
        credits: { percent: 5, minimumDelta: 10 },
      })
    ).toEqual([
      expect.objectContaining({ metricName: 'requests:user', direction: 'increase' }),
      expect.objectContaining({ metricName: 'credits', direction: 'decrease' }),
    ]);
    expect(anomalyAlerts([metric(10, 0)], window, {})[0].direction).toBe('increase');
  });

  it('provides current, previous, median and escaped top contributors in Slack', () => {
    const messages = anomalyMessages(
      [{ ...metric(200), contributors: [{ label: '<!channel>', value: 50 }] }],
      comparisonWindow(new Date('2026-10-26T12:05:00Z')),
      {}
    );
    expect(messages[0]).toContain('Current 200.00; previous 100.00');
    expect(messages[0]).toContain('7-day median 110.00');
    expect(messages[0]).toContain('&lt;!channel&gt;=+50.00');
    expect(messages[0]).toContain('(12h)');
  });
});
