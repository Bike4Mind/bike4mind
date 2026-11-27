import type { QaCounts, QaMetric, QaRunStatus } from '@bike4mind/common';

/**
 * Period summary for the /status "Scheduled runs summary" section (weekly ops report). Pure, so the
 * definitions are unit-tested without a database; getQaSummary in reads.ts feeds it scheduled
 * runs only.
 *
 * Definitions:
 * - E2E pass rate = passed / (passed + failed + skipped + notStarted), summed over runs.
 * - An E2E run passed (cleanRuns) when it has failed 0, notStarted 0 and is not an infra-error.
 * - Latency check rate = checks within their threshold / checks with a threshold. A latency run that
 *   reported no latency result at all (it crashed before measuring) counts each of its tests, at
 *   least one, as a check over the limit, so a crash lowers the rate instead of vanishing from it.
 * - A latency run passed when its status is passed and every check is within its threshold.
 */

/** CI sends "Run via Schedule" (or the raw GitHub event name "schedule"). */
export const SCHEDULED_TRIGGER = /schedule/i;

export interface QaSummaryRunInput {
  product: string;
  suite: string;
  status: QaRunStatus;
  counts: QaCounts;
  metrics?: QaMetric[];
}

export interface QaE2eStats {
  runs: number;
  cleanRuns: number;
  passed: number;
  tests: number;
  /** null when no test was counted. */
  passRate: number | null;
}

export interface QaLatencyStats {
  runs: number;
  passedRuns: number;
  checks: number;
  checksWithinLimit: number;
  /** null only when no check was counted. */
  checkRate: number | null;
}

export interface QaProductSummary {
  product: string;
  e2e: QaE2eStats | null;
  latency: QaLatencyStats | null;
}

export interface QaSummary {
  from: string;
  to: string;
  products: QaProductSummary[];
  /** True when a product hit the per-product run cap, so its oldest runs were left out. */
  truncated: boolean;
}

const ratio = (n: number, d: number) => (d > 0 ? n / d : null);

function e2eStats(runs: QaSummaryRunInput[]): QaE2eStats {
  let passed = 0;
  let tests = 0;
  let cleanRuns = 0;
  for (const { counts, status } of runs) {
    passed += counts.passed;
    tests += counts.passed + counts.failed + counts.skipped + counts.notStarted;
    if (status !== 'infra-error' && counts.failed === 0 && counts.notStarted === 0) cleanRuns += 1;
  }
  return { runs: runs.length, cleanRuns, passed, tests, passRate: ratio(passed, tests) };
}

const latencyResults = (run: QaSummaryRunInput) => (run.metrics ?? []).filter(m => m.kind === 'latency');

function latencyStats(runs: QaSummaryRunInput[]): QaLatencyStats {
  let checks = 0;
  let checksWithinLimit = 0;
  let passedRuns = 0;
  for (const run of runs) {
    const results = latencyResults(run);
    const runChecks = results.filter(m => m.threshold !== undefined);
    const within = runChecks.filter(m => m.value <= (m.threshold as number)).length;
    if (results.length === 0) {
      const { passed, failed, skipped, notStarted } = run.counts;
      checks += Math.max(1, passed + failed + skipped + notStarted);
    } else {
      checks += runChecks.length;
      checksWithinLimit += within;
      if (run.status === 'passed' && within === runChecks.length) passedRuns += 1;
    }
  }
  return { runs: runs.length, passedRuns, checks, checksWithinLimit, checkRate: ratio(checksWithinLimit, checks) };
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

/**
 * One card per product. A suite counts as latency when `knownLatencySuites` (per product, from runs
 * outside the range too) names it or any of its runs here carries a latency metric. A latency run
 * that produced no result therefore lands in the latency figures as not passed, even when every
 * run of that suite in the range crashed.
 */
export function summarizeQaRuns(
  runs: QaSummaryRunInput[],
  knownLatencySuites: ReadonlyMap<string, ReadonlySet<string>> = new Map()
): QaProductSummary[] {
  return [...groupBy(runs, r => r.product)]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([product, productRuns]) => {
      const latencySuites = new Set(knownLatencySuites.get(product));
      for (const r of productRuns) {
        if (latencyResults(r).length > 0) latencySuites.add(r.suite);
      }
      const e2eRuns = productRuns.filter(r => !latencySuites.has(r.suite));
      const latencyRuns = productRuns.filter(r => latencySuites.has(r.suite));

      return {
        product,
        e2e: e2eRuns.length > 0 ? e2eStats(e2eRuns) : null,
        latency: latencyRuns.length > 0 ? latencyStats(latencyRuns) : null,
      };
    });
}
