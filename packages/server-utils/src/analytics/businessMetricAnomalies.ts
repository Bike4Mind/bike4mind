import { z } from 'zod';

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
const DEFAULT_MINIMUM_DELTAS = new Map([
  ['spendUsd', 5],
  ['credits', 100],
  ['payingSubscribers', 2],
  ['revenueMinor', 1000],
]);
export const thresholdSchema = z.object({
  percent: z.number().finite().nonnegative().default(5),
  minimumDelta: z.number().finite().positive(),
});
export const thresholdsSchema = z.record(z.string(), thresholdSchema);
export type Thresholds = z.infer<typeof thresholdsSchema>;
export type Metric = {
  name: string;
  values: Array<number | null>;
  contributors: Array<{ label: string; value: number }>;
};
export type BusinessMetricAnomaly = {
  metricName: string;
  direction: 'increase' | 'decrease';
  message: string;
};
export type ComparisonWindow = { end: Date; duration: number; mode: 'daily' | 'intraday' };

export function comparisonWindow(at: Date): ComparisonWindow {
  const end = new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
  const elapsed = end.getTime() % DAY_MS;
  return { end, duration: elapsed || DAY_MS, mode: elapsed === 0 ? 'daily' : 'intraday' };
}

/** Index zero is the current period; all seven previous periods use the same UTC cutoff. */
export function periodIndex(at: Date, window: ComparisonWindow): number | null {
  const distance = window.end.getTime() - at.getTime();
  if (distance <= 0) return null;
  const index = Math.floor((distance - 1) / DAY_MS);
  if (index > 7 || distance - index * DAY_MS > window.duration) return null;
  return index;
}

export function thresholdFor(name: string, overrides: Thresholds): z.infer<typeof thresholdSchema> {
  const family = name.split(':')[0];
  const minimumDelta = DEFAULT_MINIMUM_DELTAS.get(family) ?? 10;
  return overrides[name] ?? overrides[family] ?? { percent: 5, minimumDelta };
}

export function compareMetric(metric: Metric, thresholds: Thresholds) {
  const [current, previous] = metric.values;
  const history = metric.values
    .slice(1)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const median = history.length === 7 ? history[3] : null;
  if (current == null || previous == null) return null;
  const delta = current - previous;
  const percent = previous === 0 ? null : (delta / previous) * 100;
  const threshold = thresholdFor(metric.name, thresholds);
  if (Math.abs(delta) < threshold.minimumDelta || delta === 0) return null;
  if (percent !== null && Math.abs(percent) <= threshold.percent) return null;
  return { ...metric, current, previous, delta, percent, median };
}

const escapeSlack = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function anomalyAlerts(
  metrics: Metric[],
  window: ComparisonWindow,
  thresholds: Thresholds
): BusinessMetricAnomaly[] {
  return metrics.flatMap<BusinessMetricAnomaly>(metric => {
    const anomaly = compareMetric(metric, thresholds);
    if (!anomaly) return [];
    const change = anomaly.percent === null ? 'new activity (previously zero)' : `${anomaly.percent.toFixed(1)}%`;
    const contributors = metric.contributors
      .filter(row => (anomaly.delta > 0 ? row.value > 0 : row.value < 0))
      .sort((a, b) => (anomaly.delta > 0 ? b.value - a.value : a.value - b.value))
      .slice(0, 5);
    const message =
      `Business metric anomaly: ${escapeSlack(metric.name)}\n` +
      `${window.mode}, UTC through ${window.end.toISOString()} (${window.duration / HOUR_MS}h)\n` +
      `Current ${anomaly.current.toFixed(2)}; previous ${anomaly.previous.toFixed(2)}; change ${change}; ` +
      `7-day median ${anomaly.median === null ? 'warming up' : anomaly.median.toFixed(2)}\n` +
      `Top contributors: ${contributors.map(row => `${escapeSlack(row.label)}=${row.value > 0 ? '+' : ''}${row.value.toFixed(2)}`).join(', ') || 'none'}`;
    return [{ metricName: metric.name, direction: anomaly.delta > 0 ? 'increase' : 'decrease', message }];
  });
}

export function anomalyMessages(metrics: Metric[], window: ComparisonWindow, thresholds: Thresholds): string[] {
  return anomalyAlerts(metrics, window, thresholds).map(anomaly => anomaly.message);
}

export function createMetricAccumulator() {
  const metrics = new Map<string, Metric>();
  const contributors = new Map<string, Map<string, number>>();
  const ensure = (name: string) => {
    const metric = metrics.get(name) ?? { name, values: Array<number>(8).fill(0), contributors: [] };
    metrics.set(name, metric);
    return metric;
  };
  return {
    ensure,
    add(name: string, index: number, value: number, labels: string[] = []) {
      if (!Number.isFinite(value)) throw new Error(`Non-finite metric: ${name}`);
      const metric = ensure(name);
      metric.values[index] = (metric.values[index] ?? 0) + value;
      if (index !== 0 && index !== 1) return;
      const totals = contributors.get(name) ?? new Map<string, number>();
      const signedValue = index === 0 ? value : -value;
      for (const label of labels) totals.set(label, (totals.get(label) ?? 0) + signedValue);
      contributors.set(name, totals);
    },
    result() {
      return [...metrics.values()].map(metric => ({
        ...metric,
        contributors: [...(contributors.get(metric.name) ?? [])].map(([label, value]) => ({ label, value })),
      }));
    },
  };
}
