import { describe, it, expect } from 'vitest';
import { durationData, MAX_SERIES, metricData, passRateData } from './chartData';
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
