import type { QaMetric } from '@bike4mind/common';
import type { QaSeriesPoint } from '@client/app/hooks/data/qaStatus';
import { stateLabel } from './format';

/** Categorical palette size; a 9th series is counted in `hidden`, never given a generated hue. */
export const MAX_SERIES = 8;

/** Latency specs without a label share one group. */
export const UNLABELED = 'default';

export type ChartRange = '7d' | '30d';

/** 30d plots one bucket per local day; 7d one point per run. */
const DAILY_RANGE: ChartRange = '30d';
const DAILY_TICK_STEP = 3;

export type ChartRow = { t: number } & Record<string, number | null | undefined>;

export interface ChartSeries {
  key: string;
  /** Failing limit: pass rate below it, a metric above it. Undefined: never failing. */
  limit?: number;
}

export interface ChartData {
  rows: ChartRow[];
  series: ChartSeries[];
  thresholds: number[];
  hidden: number;
  unit: string;
  fail: 'above' | 'below';
  /** Local-midnight x ticks across the row range: daily on 7d, every 3rd day on 30d. */
  ticks: number[];
  /** Rows are daily buckets (30d), so `runs` is meaningful. */
  daily: boolean;
  /** Distinct runs per daily bucket, keyed by row `t`. Empty unless `daily`. */
  runs: Record<number, number>;
}

export interface Entry {
  t: number;
  runId: string;
  key: string;
  value: number | null;
  threshold?: number;
  unit?: string;
}

type Agg = 'min' | 'median';

export interface Bucket extends Pick<Entry, 't' | 'key' | 'value'> {
  runIds: string[];
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function startOfLocalDay(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Local midnights from min's day up to max, `stepDays` apart. Calendar arithmetic, so DST days stay aligned. */
export function dayTicks(min: number, max: number, stepDays: number): number[] {
  const first = new Date(min);
  const step = Math.max(1, Math.floor(stepDays));
  const ticks: number[] = [];
  for (let i = 0; ; i += step) {
    const t = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i).getTime();
    if (t > max) break;
    ticks.push(t);
  }
  return ticks;
}

/**
 * Collapses entries to one per (series, local day), stamped at that day's midnight.
 * A day with only null values stays null. `runIds` feeds the tooltip's run count.
 */
export function bucketByDay(entries: Entry[], agg: Agg, round: (n: number) => number = n => n): Bucket[] {
  const groups = new Map<string, { t: number; key: string; values: number[]; runIds: Set<string> }>();
  for (const e of entries) {
    const t = startOfLocalDay(e.t);
    const id = `${t}|${e.key}`;
    const g = groups.get(id) ?? { t, key: e.key, values: [], runIds: new Set<string>() };
    if (e.value !== null) g.values.push(e.value);
    g.runIds.add(e.runId);
    groups.set(id, g);
  }
  return [...groups.values()].map(g => ({
    t: g.t,
    key: g.key,
    value: g.values.length === 0 ? null : round(agg === 'min' ? Math.min(...g.values) : median(g.values)),
    runIds: [...g.runIds],
  }));
}

/** A value past its limit: below for pass rate, above for metrics. */
export function isFailing(value: unknown, limit: number | undefined, fail: ChartData['fail']): boolean {
  if (typeof value !== 'number' || limit === undefined) return false;
  return fail === 'below' ? value < limit : value > limit;
}

interface BuildOptions {
  unit: string;
  agg: Agg;
  fail: ChartData['fail'];
  range: ChartRange;
  /** One limit for every series; otherwise each series uses the last threshold it reported. */
  limit?: number;
  round?: (n: number) => number;
}

/** Series keep first-appearance order so a state keeps its color across renders. */
function build(entries: Entry[], o: BuildOptions): ChartData {
  const order: string[] = [];
  for (const e of entries) if (!order.includes(e.key)) order.push(e.key);
  const kept = new Set(order.slice(0, MAX_SERIES));
  const keptEntries = entries.filter(e => kept.has(e.key));
  const daily = o.range === DAILY_RANGE;

  const limits = new Map<string, number>();
  const thresholds: number[] = [];
  let unit = o.unit;
  for (const e of keptEntries) {
    if (e.threshold !== undefined) {
      limits.set(e.key, e.threshold);
      if (!thresholds.includes(e.threshold)) thresholds.push(e.threshold);
    }
    if (e.unit) unit = e.unit;
  }

  const runs: Record<number, number> = {};
  let plotted: Array<Pick<Entry, 't' | 'key' | 'value'>> = keptEntries;
  if (daily) {
    const buckets = bucketByDay(keptEntries, o.agg, o.round);
    plotted = buckets;
    const perDay = new Map<number, Set<string>>();
    for (const b of buckets) {
      const ids = perDay.get(b.t) ?? new Set<string>();
      b.runIds.forEach(id => ids.add(id));
      perDay.set(b.t, ids);
    }
    for (const [day, ids] of perDay) runs[day] = ids.size;
  }

  const rows = new Map<number, ChartRow>();
  for (const e of plotted) {
    const row: ChartRow = rows.get(e.t) ?? { t: e.t };
    row[e.key] = e.value;
    rows.set(e.t, row);
  }
  const sorted = [...rows.values()].sort((a, b) => a.t - b.t);

  return {
    rows: sorted,
    series: [...kept].map(key => ({ key, limit: o.limit ?? limits.get(key) })),
    thresholds,
    hidden: order.length - kept.size,
    unit,
    fail: o.fail,
    ticks: sorted.length ? dayTicks(sorted[0].t, sorted[sorted.length - 1].t, daily ? DAILY_TICK_STEP : 1) : [],
    daily,
    runs,
  };
}

const at = (p: QaSeriesPoint) => Date.parse(p.startedAt);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Percent, one decimal. A day's bucket is its worst run, so a failure is never averaged away. */
export function passRateData(points: QaSeriesPoint[], range: ChartRange = '7d'): ChartData {
  return build(
    points.map(p => ({
      t: at(p),
      runId: p.runId,
      key: stateLabel(p),
      value: p.passRate === null ? null : Math.round(p.passRate * 1000) / 10,
    })),
    { unit: '%', agg: 'min', fail: 'below', limit: 100, range }
  );
}

/** Minutes, one decimal. durationMs <= 0 (backfilled runs) is unknown, so it plots as a gap, not 0. */
export function durationData(points: QaSeriesPoint[], range: ChartRange = '7d'): ChartData {
  return build(
    points.map(p => ({
      t: at(p),
      runId: p.runId,
      key: stateLabel(p),
      value: p.durationMs > 0 ? round1(p.durationMs / 60_000) : null,
    })),
    { unit: 'min', agg: 'median', fail: 'above', range, round: round1 }
  );
}

/** Y domain for percent values: 5-point padding, clamped to 0-100, whole numbers. No values: full range. */
export function percentDomain(values: Array<number | null | undefined>): [number, number] {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return [0, 100];
  return [Math.max(0, Math.floor(Math.min(...nums) - 5)), Math.min(100, Math.ceil(Math.max(...nums) + 5))];
}

/** One series per model (plus label, since latency thresholds differ per spec for one model). */
export function metricData(points: QaSeriesPoint[], kind: QaMetric['kind'], range: ChartRange = '7d'): ChartData {
  return build(
    points.flatMap(p =>
      p.metrics
        .filter(m => m.kind === kind)
        .map(m => ({
          t: at(p),
          runId: p.runId,
          key: m.label ? `${m.model} (${m.label})` : m.model,
          value: m.value,
          threshold: m.threshold,
          unit: m.unit,
        }))
    ),
    { unit: '', agg: 'median', fail: 'above', range }
  );
}

export interface LatencyData {
  /** Shared across every group, in first-appearance order, capped at MAX_SERIES. */
  models: string[];
  hidden: number;
  unit: string;
  /** One chart per spec label; series are models, so each carries only its own spec's threshold. */
  groups: Array<{ label: string; data: ChartData }>;
}

export function latencyData(points: QaSeriesPoint[], range: ChartRange = '7d'): LatencyData {
  const rows = points.flatMap(p =>
    p.metrics
      .filter(m => m.kind === 'latency')
      .map(m => ({
        label: m.label ?? UNLABELED,
        entry: {
          t: at(p),
          runId: p.runId,
          key: m.model,
          value: m.value,
          threshold: m.threshold,
          unit: m.unit,
        } satisfies Entry,
      }))
  );
  const all = [...new Set(rows.map(r => r.entry.key))];
  const models = all.slice(0, MAX_SERIES);
  const labels = [...new Set(rows.map(r => r.label))];
  const groups = labels.map(label => {
    const entries = rows.filter(r => r.label === label && models.includes(r.entry.key)).map(r => r.entry);
    const data = build(entries, { unit: '', agg: 'median', fail: 'above', range });
    data.series.sort((a, b) => models.indexOf(a.key) - models.indexOf(b.key));
    return { label, data };
  });
  return {
    models,
    hidden: all.length - models.length,
    unit: groups.find(g => g.data.unit)?.data.unit ?? '',
    groups,
  };
}
