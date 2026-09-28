import type { QaMetric } from '@bike4mind/common';
import type { QaSeriesPoint } from '@client/app/hooks/data/qaStatus';
import { stateLabel } from './format';

/** Categorical palette size; a 9th series is counted in `hidden`, never given a generated hue. */
export const MAX_SERIES = 8;

export type ChartRow = { t: number } & Record<string, number | null | undefined>;

export interface ChartData {
  rows: ChartRow[];
  series: { key: string }[];
  thresholds: number[];
  hidden: number;
  unit: string;
}

interface Entry {
  t: number;
  key: string;
  value: number | null;
  threshold?: number;
  unit?: string;
}

/** Series keep first-appearance order so a state keeps its color across renders. */
function build(entries: Entry[], unit: string): ChartData {
  const order: string[] = [];
  for (const e of entries) if (!order.includes(e.key)) order.push(e.key);
  const kept = new Set(order.slice(0, MAX_SERIES));
  const rows = new Map<number, ChartRow>();
  const thresholds: number[] = [];
  let resolvedUnit = unit;
  for (const e of entries) {
    if (!kept.has(e.key)) continue;
    const row: ChartRow = rows.get(e.t) ?? { t: e.t };
    row[e.key] = e.value;
    rows.set(e.t, row);
    if (e.threshold !== undefined && !thresholds.includes(e.threshold)) thresholds.push(e.threshold);
    if (e.unit) resolvedUnit = e.unit;
  }
  return {
    rows: [...rows.values()].sort((a, b) => a.t - b.t),
    series: [...kept].map(key => ({ key })),
    thresholds,
    hidden: order.length - kept.size,
    unit: resolvedUnit,
  };
}

const at = (p: QaSeriesPoint) => Date.parse(p.startedAt);

/** Percent, one decimal. */
export function passRateData(points: QaSeriesPoint[]): ChartData {
  return build(
    points.map(p => ({
      t: at(p),
      key: stateLabel(p),
      value: p.passRate === null ? null : Math.round(p.passRate * 1000) / 10,
    })),
    '%'
  );
}

/** Minutes, one decimal. */
export function durationData(points: QaSeriesPoint[]): ChartData {
  return build(
    points.map(p => ({ t: at(p), key: stateLabel(p), value: Math.round((p.durationMs / 60_000) * 10) / 10 })),
    'min'
  );
}

/** One series per model (plus label, since latency thresholds differ per spec for one model). */
export function metricData(points: QaSeriesPoint[], kind: QaMetric['kind']): ChartData {
  return build(
    points.flatMap(p =>
      p.metrics
        .filter(m => m.kind === kind)
        .map(m => ({
          t: at(p),
          key: m.label ? `${m.model} (${m.label})` : m.model,
          value: m.value,
          threshold: m.threshold,
          unit: m.unit,
        }))
    ),
    ''
  );
}
