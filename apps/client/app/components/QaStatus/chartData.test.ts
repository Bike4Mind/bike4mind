import { describe, it, expect } from 'vitest';
import {
  bucketByDay,
  dayLabel,
  dayTicks,
  durationData,
  isFailing,
  latencyData,
  MAX_SERIES,
  median,
  metricData,
  passRateData,
  percentDomain,
  startOfLocalDay,
  tooltipLabel,
  UNLABELED,
  type Entry,
} from './chartData';
import type { QaSeriesPoint } from '@client/app/hooks/data/qaStatus';

const point = (o: Partial<QaSeriesPoint>): QaSeriesPoint => ({
  runId: 'r',
  suite: 'Core',
  env: 'staging',
  startedAt: '2026-09-28T09:00:00.000Z',
  status: 'passed',
  passRate: 1,
  durationMs: 60_000,
  metrics: [],
  ...o,
});

/** Local wall-clock time in Sept 2026, so bucketing assertions hold in any timezone. */
const local = (day: number, hour = 0, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
const iso = (t: number) => new Date(t).toISOString();

describe('chartData', () => {
  it('keys pass rate by state label in first-appearance order, as percent', () => {
    const d = passRateData([
      point({ env: 'staging', passRate: 0.5 }),
      point({ env: 'production', startedAt: '2026-09-28T10:00:00.000Z' }),
      point({ env: 'staging', passRate: null, startedAt: '2026-09-28T11:00:00.000Z' }),
    ]);
    expect(d.series.map(s => s.key)).toEqual(['Core . staging', 'Core . production']);
    expect(d.rows.map(r => r['Core . staging'])).toEqual([50, undefined, null]);
    expect(d.rows[0].t).toBe(Date.parse('2026-09-28T09:00:00.000Z'));
  });

  it('converts duration to minutes', () => {
    expect(durationData([point({ durationMs: 252_000 })]).rows[0]['Core . staging']).toBe(4.2);
  });

  it('plots durationMs <= 0 (backfilled, unknown) as a gap, not zero', () => {
    const d = durationData([
      point({ durationMs: 0 }),
      point({ durationMs: -1, startedAt: '2026-09-28T10:00:00.000Z' }),
      point({ durationMs: 60_000, startedAt: '2026-09-28T11:00:00.000Z' }),
    ]);
    expect(d.rows.map(r => r['Core . staging'])).toEqual([null, null, 1]);
  });

  it('keys metrics by model and label, and collects distinct thresholds', () => {
    const d = metricData(
      [
        point({
          metrics: [
            { kind: 'latency', model: 'model-x', label: 'short', value: 3, unit: 's', threshold: 5 },
            { kind: 'latency', model: 'model-x', label: 'long', value: 9, unit: 's', threshold: 15 },
            { kind: 'credits', model: 'model-x', value: 12, unit: 'credits', threshold: 30 },
          ],
        }),
      ],
      'latency'
    );
    expect(d.series.map(s => s.key)).toEqual(['model-x (short)', 'model-x (long)']);
    expect(d.thresholds).toEqual([5, 15]);
    expect(d.unit).toBe('s');
  });

  it('caps at 8 series and counts the rest', () => {
    const points = Array.from({ length: 10 }, (_, i) => point({ env: `env-${i}` }));
    const d = passRateData(points);
    expect(d.series).toHaveLength(MAX_SERIES);
    expect(d.hidden).toBe(2);
  });
});

describe('percentDomain', () => {
  it('pads all-100 values down to 95', () => {
    expect(percentDomain([100, 100, 100])).toEqual([95, 100]);
  });

  it('pads a dip to 85 down to 80', () => {
    expect(percentDomain([100, 85, 100])).toEqual([80, 100]);
  });

  it('floors the low end and ceils the high end to whole numbers', () => {
    expect(percentDomain([82.3, 90.2])).toEqual([77, 96]);
  });

  it('clamps at 0 near the bottom', () => {
    expect(percentDomain([2, 100])).toEqual([0, 100]);
  });

  it('ignores nulls and undefined', () => {
    expect(percentDomain([null, 90, undefined, 100])).toEqual([85, 100]);
  });

  it('falls back to 0-100 with no values', () => {
    expect(percentDomain([])).toEqual([0, 100]);
    expect(percentDomain([null, undefined])).toEqual([0, 100]);
  });
});

describe('median', () => {
  it('takes the middle value, or the mean of the middle two', () => {
    expect(median([9, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([7])).toBe(7);
  });
});

describe('daily bucketing (30d)', () => {
  const day = (d: number, h: number, o: Partial<QaSeriesPoint> = {}) =>
    point({ runId: `r-${d}-${h}`, startedAt: iso(local(d, h)), ...o });

  it('keeps one point per run on 7d', () => {
    const d = passRateData([day(28, 9), day(28, 10)], '7d');
    expect(d.rows).toHaveLength(2);
    expect(d.daily).toBe(false);
    expect(d.runs).toEqual({});
  });

  it('uses the worst run as the pass rate for the day', () => {
    const d = passRateData(
      [day(28, 9, { passRate: 1 }), day(28, 10, { passRate: 0.5 }), day(28, 11, { passRate: 1 })],
      '30d'
    );
    expect(d.rows).toEqual([{ t: local(28), 'Core . staging': 50 }]);
  });

  it('uses the median duration for the day', () => {
    const d = durationData(
      [day(28, 9, { durationMs: 60_000 }), day(28, 10, { durationMs: 120_000 }), day(28, 11, { durationMs: 540_000 })],
      '30d'
    );
    expect(d.rows[0]['Core . staging']).toBe(2);
    const even = durationData([day(28, 9, { durationMs: 60_000 }), day(28, 10, { durationMs: 120_000 })], '30d');
    expect(even.rows[0]['Core . staging']).toBe(1.5);
  });

  it('ignores unknown durations inside a bucket, and keeps an all-unknown day as a gap', () => {
    const d = durationData(
      [day(28, 9, { durationMs: 0 }), day(28, 10, { durationMs: 180_000 }), day(29, 9, { durationMs: 0 })],
      '30d'
    );
    expect(d.rows.map(r => r['Core . staging'])).toEqual([3, null]);
  });

  it('uses the median for credits and latency', () => {
    const metric = (value: number) => ({ kind: 'credits' as const, model: 'm', value, unit: 'credits' });
    const d = metricData(
      [
        day(28, 9, { metrics: [metric(10)] }),
        day(28, 10, { metrics: [metric(50)] }),
        day(28, 11, { metrics: [metric(12)] }),
      ],
      'credits',
      '30d'
    );
    expect(d.rows[0].m).toBe(12);
  });

  it('stamps buckets at local midnight and splits at the local day boundary', () => {
    const d = passRateData(
      [
        point({ runId: 'a', startedAt: iso(local(28, 23, 59)), passRate: 1 }),
        point({ runId: 'b', startedAt: iso(local(29, 0, 1)), passRate: 0.5 }),
      ],
      '30d'
    );
    expect(d.rows.map(r => r.t)).toEqual([local(28), local(29)]);
    expect(d.rows.map(r => r['Core . staging'])).toEqual([100, 50]);
  });

  it('counts distinct runs per bucket across series', () => {
    const d = passRateData(
      [day(28, 9), day(28, 10), day(28, 11, { env: 'production' }), day(29, 9, { env: 'production' })],
      '30d'
    );
    expect(d.runs).toEqual({ [local(28)]: 3, [local(29)]: 1 });
    expect(d.rows[0]).toEqual({ t: local(28), 'Core . staging': 100, 'Core . production': 100 });
  });

  it('titles a daily tooltip "<date>: N runs", singular for one', () => {
    const d = passRateData(
      [day(28, 9), day(28, 10), day(28, 11, { env: 'production' }), day(29, 9, { env: 'production' })],
      '30d'
    );
    const three = tooltipLabel(d, local(28));
    expect(three).toBe(`${dayLabel(local(28))}: 3 runs`);
    expect(three).toMatch(/28.*: 3 runs$/);
    expect(tooltipLabel(d, local(29))).toBe(`${dayLabel(local(29))}: 1 run`);
    expect(tooltipLabel(d, local(30))).toBe(`${dayLabel(local(30))}: 0 runs`);
  });

  it('titles a per-run tooltip with the full timestamp on 7d', () => {
    const d = passRateData([day(28, 9)], '7d');
    expect(tooltipLabel(d, local(28, 9))).toBe(new Date(local(28, 9)).toLocaleString());
  });

  it('buckets each series on its own', () => {
    const entries: Entry[] = [
      { t: local(28, 9), runId: 'a', key: 'x', value: 4 },
      { t: local(28, 10), runId: 'b', key: 'y', value: 8 },
      { t: local(28, 11), runId: 'c', key: 'x', value: 6 },
    ];
    const b = bucketByDay(entries, 'median');
    expect(b.map(({ key, value, runIds }) => ({ key, value, runIds }))).toEqual([
      { key: 'x', value: 5, runIds: ['a', 'c'] },
      { key: 'y', value: 8, runIds: ['b'] },
    ]);
  });
});

describe('x ticks', () => {
  it('ticks every local midnight on 7d', () => {
    const d = passRateData([
      point({ startedAt: iso(local(28, 9)) }),
      point({ startedAt: iso(local(30, 14)) }),
      point({ startedAt: iso(local(31, 8)) }),
    ]);
    expect(d.ticks).toEqual([local(28), local(29), local(30), local(31)]);
  });

  it('ticks every 3rd day on 30d', () => {
    const points = Array.from({ length: 10 }, (_, i) => point({ runId: `r${i}`, startedAt: iso(local(10 + i, 9)) }));
    const d = passRateData(points, '30d');
    expect(d.ticks).toEqual([local(10), local(13), local(16), local(19)]);
  });

  it('has no ticks without rows', () => {
    expect(passRateData([]).ticks).toEqual([]);
  });

  it('steps by calendar day, not by 24h', () => {
    const ticks = dayTicks(local(1, 9), local(5, 1), 1);
    expect(ticks).toEqual([local(1), local(2), local(3), local(4), local(5)]);
    expect(ticks.every(t => startOfLocalDay(t) === t)).toBe(true);
  });
});

describe('failing points', () => {
  it('fails pass rate below 100 and metrics above their limit', () => {
    expect(isFailing(99.9, 100, 'below')).toBe(true);
    expect(isFailing(100, 100, 'below')).toBe(false);
    expect(isFailing(5.1, 5, 'above')).toBe(true);
    expect(isFailing(5, 5, 'above')).toBe(false);
  });

  it('never fails a gap or a series without a limit', () => {
    expect(isFailing(null, 100, 'below')).toBe(false);
    expect(isFailing(undefined, 5, 'above')).toBe(false);
    expect(isFailing(500, undefined, 'above')).toBe(false);
  });

  it('gives pass rate series a limit of 100, below which a bucket fails', () => {
    const d = passRateData([point({ passRate: 0.5 })], '30d');
    expect(d.fail).toBe('below');
    expect(d.series[0].limit).toBe(100);
    expect(d.thresholds).toEqual([]);
  });

  it('takes a metric series limit from its own threshold', () => {
    const d = metricData(
      [
        point({
          metrics: [
            { kind: 'credits', model: 'a', value: 12, unit: 'credits', threshold: 30 },
            { kind: 'credits', model: 'b', value: 12, unit: 'credits' },
          ],
        }),
      ],
      'credits'
    );
    expect(d.fail).toBe('above');
    expect(d.series.map(s => s.limit)).toEqual([30, undefined]);
  });

  it('gives duration no limit', () => {
    expect(durationData([point({})]).series[0].limit).toBeUndefined();
  });
});

describe('latencyData', () => {
  const m = (model: string, label: string | undefined, value: number, threshold: number) => ({
    kind: 'latency' as const,
    model,
    ...(label ? { label } : {}),
    value,
    unit: 's',
    threshold,
  });

  it('groups by label with series per model and only that label threshold', () => {
    const d = latencyData([
      point({ metrics: [m('x', 'short', 3, 5), m('y', 'short', 4, 5), m('x', 'long', 9, 15)] }),
      point({ startedAt: '2026-09-28T10:00:00.000Z', metrics: [m('y', 'long', 20, 15)] }),
    ]);
    expect(d.models).toEqual(['x', 'y']);
    expect(d.unit).toBe('s');
    expect(d.groups.map(g => g.label)).toEqual(['short', 'long']);
    const [short, long] = d.groups.map(g => g.data);
    expect(short.series.map(s => s.key)).toEqual(['x', 'y']);
    expect(short.thresholds).toEqual([5]);
    expect(long.thresholds).toEqual([15]);
    expect(long.series.map(s => s.limit)).toEqual([15, 15]);
  });

  it('keeps global model order inside a group that sees the models in another order', () => {
    const d = latencyData([
      point({ metrics: [m('x', 'a', 1, 5), m('y', 'a', 1, 5), m('y', 'b', 1, 5), m('x', 'b', 1, 5)] }),
    ]);
    expect(d.groups[1].data.series.map(s => s.key)).toEqual(['x', 'y']);
  });

  it('puts unlabeled specs in one group', () => {
    const d = latencyData([point({ metrics: [m('x', undefined, 1, 5)] })]);
    expect(d.groups.map(g => g.label)).toEqual([UNLABELED]);
  });

  it('caps models at 8 across all groups and counts the rest', () => {
    const metrics = Array.from({ length: 10 }, (_, i) => m(`model-${i}`, i % 2 ? 'odd' : 'even', 1, 5));
    const d = latencyData([point({ metrics })]);
    expect(d.models).toHaveLength(MAX_SERIES);
    expect(d.hidden).toBe(2);
    expect(d.groups.flatMap(g => g.data.series.map(s => s.key))).not.toContain('model-9');
  });

  it('buckets daily on 30d', () => {
    const at = (d: number, h: number, value: number) =>
      point({ runId: `r${d}-${h}`, startedAt: iso(local(d, h)), metrics: [m('x', 'a', value, 5)] });
    const d = latencyData([at(28, 9, 1), at(28, 10, 9), at(28, 11, 3)], '30d');
    expect(d.groups[0].data.rows).toEqual([{ t: local(28), x: 3 }]);
    expect(d.groups[0].data.runs).toEqual({ [local(28)]: 3 });
  });

  it('is empty without latency metrics', () => {
    expect(latencyData([point({})])).toMatchObject({ models: [], groups: [], hidden: 0, unit: '' });
  });
});
