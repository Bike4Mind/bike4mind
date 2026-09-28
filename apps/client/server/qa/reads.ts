import { QaRun, QaTestResult } from '@bike4mind/database';
import {
  computeFlakeRate,
  QA_FLAKY_THRESHOLD,
  QA_MEDIA_RETENTION_DAYS,
  type IQaRun,
  type IQaTestResult,
  type QaArtifactKind,
  type QaCounts,
  type QaMetric,
  type QaRunSource,
  type QaRunStatus,
  type QaSuiteSummary,
  type QaTestStatus,
} from '@bike4mind/common';
import type { QaFilters } from './filters';
import type { QaMediaStorage } from './storage';
import { leadingNonPassing, stateKeyFilter } from './streak';

/** Read models for the admin /status page (app/hooks/data/qaStatus.ts imports these types). */
export type { QaFilters };

const DAY_MS = 86_400_000;
const STREAK_LOOKBACK = 50;
const SERIES_MAX_RUNS = 2000;
const FLAKY_ROWS = 10;
const HISTORY_LIMIT = 50;
export const QA_RUNS_PAGE_SIZE = 50;

type LeanRun = IQaRun & { _id: unknown };

export interface QaFacets {
  products: string[];
  tenants: string[];
  envs: string[];
  branches: string[];
}

export interface QaRunSummary {
  id: string;
  product: string;
  tenant?: string;
  suite: string;
  env: string;
  branch: string;
  trigger: string;
  source: QaRunSource;
  status: QaRunStatus;
  startedAt: string;
  durationMs: number;
  counts: QaCounts;
  ciRunUrl: string;
  sha: string;
}

export interface QaRunPage {
  runs: QaRunSummary[];
  nextBefore?: string;
}

export interface QaTile {
  suite: string;
  env: string;
  tenant?: string;
  status: QaRunStatus;
  latestRunId: string;
  startedAt: string;
  /** Start of the current non-passing streak. */
  failingSince?: string;
  nonPassingRuns: number;
  failedCount: number;
}

export interface QaSeriesPoint {
  runId: string;
  suite: string;
  env: string;
  tenant?: string;
  startedAt: string;
  status: QaRunStatus;
  /** passed / ran; null when nothing ran. */
  passRate: number | null;
  durationMs: number;
  metrics: QaMetric[];
}

export interface QaFlakyRow {
  testKey: string;
  title: string;
  failures: number;
  total: number;
  rate: number;
  lastStatus: QaTestStatus;
}

export interface QaOverview {
  tiles: QaTile[];
  series: QaSeriesPoint[];
  flaky: QaFlakyRow[];
}

export interface QaMediaView {
  kind: QaArtifactKind;
  state: 'ok' | 'expired' | 'unavailable';
  url?: string;
}

export interface QaTestView {
  testKey: string;
  title: string;
  status: QaTestStatus;
  durationMs: number;
  retries: number;
  error?: string;
  media: QaMediaView[];
}

export interface QaRunDetail {
  run: QaRunSummary & { suiteSummary: QaSuiteSummary[]; metrics: QaMetric[] };
  failedTests: QaTestView[];
  flakyTests: QaTestView[];
  report: { state: 'ok' | 'expired' | 'unavailable' | 'none'; url?: string };
}

export interface QaTestHistoryRow {
  runId: string;
  status: QaTestStatus;
  startedAt: string;
  product: string;
  tenant?: string;
  suite: string;
  env: string;
  branch: string;
  durationMs: number;
  error?: string;
}

export interface QaTestHistory {
  testKey: string;
  title: string;
  flake: { failures: number; total: number; rate: number };
  rows: QaTestHistoryRow[];
}

export interface QaRunDetailDeps {
  storage: QaMediaStorage;
  signReportToken: (runId: string) => string;
  now?: Date;
}

const strings = (values: unknown[]): string[] =>
  values
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .sort()
    .slice(0, 200);

function runMatch(f: QaFilters): Record<string, unknown> {
  return {
    product: f.product,
    branch: f.branch,
    ...(f.tenant ? { tenant: f.tenant } : {}),
    ...(f.env ? { env: f.env } : {}),
  };
}

function toSummary(run: LeanRun): QaRunSummary {
  return {
    id: String(run._id),
    product: run.product,
    ...(run.tenant ? { tenant: run.tenant } : {}),
    suite: run.suite,
    env: run.env,
    branch: run.branch,
    trigger: run.trigger,
    source: run.source,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    durationMs: run.durationMs,
    counts: run.counts,
    ciRunUrl: run.ciRunUrl,
    sha: run.sha,
  };
}

export async function getQaFacets(product?: string): Promise<QaFacets> {
  const scope = product ? { product } : {};
  const [products, tenants, envs, branches] = await Promise.all([
    QaRun.distinct('product'),
    QaRun.distinct('tenant', scope),
    QaRun.distinct('env', scope),
    QaRun.distinct('branch', scope),
  ]);
  return { products: strings(products), tenants: strings(tenants), envs: strings(envs), branches: strings(branches) };
}

export async function getQaOverview(f: QaFilters, now: Date = new Date()): Promise<QaOverview> {
  const match = runMatch(f);
  const since = new Date(now.getTime() - f.rangeDays * DAY_MS);

  const latest = await QaRun.aggregate<{ run: LeanRun }>([
    { $match: match },
    { $sort: { startedAt: -1 } },
    { $group: { _id: { suite: '$suite', env: '$env', tenant: '$tenant' }, run: { $first: '$$ROOT' } } },
  ]);
  const tiles = await Promise.all(
    latest.map(async ({ run }): Promise<QaTile> => {
      const history =
        run.status === 'passed'
          ? []
          : await QaRun.find(stateKeyFilter(run))
              .sort({ startedAt: -1 })
              .limit(STREAK_LOOKBACK)
              .select('status startedAt')
              .lean<{ status: QaRunStatus; startedAt: Date }[]>();
      const streak = leadingNonPassing(history);
      return {
        suite: run.suite,
        env: run.env,
        ...(run.tenant ? { tenant: run.tenant } : {}),
        status: run.status,
        latestRunId: String(run._id),
        startedAt: run.startedAt.toISOString(),
        ...(streak.since ? { failingSince: streak.since.toISOString() } : {}),
        nonPassingRuns: streak.count,
        failedCount: run.counts.failed,
      };
    })
  );
  tiles.sort((a, b) => `${a.suite}|${a.env}|${a.tenant ?? ''}`.localeCompare(`${b.suite}|${b.env}|${b.tenant ?? ''}`));

  const runs = await QaRun.find({ ...match, startedAt: { $gte: since } })
    .sort({ startedAt: 1 })
    .limit(SERIES_MAX_RUNS)
    .lean<LeanRun[]>();
  const series = runs.map((r): QaSeriesPoint => ({
    runId: String(r._id),
    suite: r.suite,
    env: r.env,
    ...(r.tenant ? { tenant: r.tenant } : {}),
    startedAt: r.startedAt.toISOString(),
    status: r.status,
    passRate: r.counts.ran > 0 ? r.counts.passed / r.counts.ran : null,
    durationMs: r.durationMs,
    metrics: r.metrics ?? [],
  }));

  const runIds = runs.map(r => String(r._id));
  const grouped =
    runIds.length === 0
      ? []
      : await QaTestResult.aggregate<{ _id: string; title: string; statuses: QaTestStatus[] }>([
          { $match: { runId: { $in: runIds } } },
          // Drop error bodies and artifacts before the in-memory sort.
          { $project: { testKey: 1, title: 1, status: 1 } },
          { $sort: { _id: -1 } },
          { $group: { _id: '$testKey', title: { $first: '$title' }, statuses: { $push: '$status' } } },
        ]).allowDiskUse(true);
  const flaky = grouped
    .map(g => ({ testKey: g._id, title: g.title, ...computeFlakeRate(g.statuses), lastStatus: g.statuses[0] }))
    // Always-failing tests are broken, not flaky: they show on the tiles instead.
    .filter(r => r.rate >= QA_FLAKY_THRESHOLD && r.failures < r.total)
    .sort((a, b) => b.rate - a.rate || b.failures - a.failures || a.testKey.localeCompare(b.testKey))
    .slice(0, FLAKY_ROWS);

  return { tiles, series, flaky };
}

/** Cursor is `startedAt`; runs sharing the boundary timestamp can be skipped, which is acceptable here. */
export async function listQaRuns(f: QaFilters, opts: { before?: Date; limit?: number } = {}): Promise<QaRunPage> {
  const limit = Math.min(opts.limit ?? QA_RUNS_PAGE_SIZE, QA_RUNS_PAGE_SIZE);
  const runs = await QaRun.find({ ...runMatch(f), ...(opts.before ? { startedAt: { $lt: opts.before } } : {}) })
    .sort({ startedAt: -1 })
    .limit(limit + 1)
    .lean<LeanRun[]>();
  const page = runs.slice(0, limit);
  const last = page[page.length - 1];
  return {
    runs: page.map(toSummary),
    ...(runs.length > limit && last ? { nextBefore: last.startedAt.toISOString() } : {}),
  };
}

async function mediaView(
  kind: QaArtifactKind,
  key: string,
  expired: boolean,
  storage: QaMediaStorage
): Promise<QaMediaView> {
  if (expired) return { kind, state: 'expired' };
  // Lifecycle deletion timing is not exact; HEAD before handing out a URL that would 404.
  if (!(await storage.exists(key))) return { kind, state: 'unavailable' };
  return { kind, state: 'ok', url: await storage.signedGetUrl(key) };
}

export async function getQaRunDetail(id: string, deps: QaRunDetailDeps): Promise<QaRunDetail | null> {
  const run = await QaRun.findById(id).lean<LeanRun>();
  if (!run) return null;
  const runId = String(run._id);
  const expired = (deps.now ?? new Date()).getTime() - run.startedAt.getTime() > QA_MEDIA_RETENTION_DAYS * DAY_MS;

  const tests = await QaTestResult.find({ runId, status: { $in: ['failed', 'flaky'] } })
    .sort({ _id: 1 })
    .lean<IQaTestResult[]>();
  const views = await Promise.all(
    tests.map(async (t): Promise<QaTestView> => ({
      testKey: t.testKey,
      title: t.title,
      status: t.status,
      durationMs: t.durationMs,
      retries: t.retries,
      ...(t.error ? { error: t.error } : {}),
      media: await Promise.all((t.artifacts ?? []).map(a => mediaView(a.kind, a.key, expired, deps.storage))),
    }))
  );

  let report: QaRunDetail['report'] = { state: 'none' };
  if (run.reportPrefix) {
    if (expired) report = { state: 'expired' };
    else if (!(await deps.storage.exists(`${run.reportPrefix}index.html`))) report = { state: 'unavailable' };
    else {
      // Token in the path, not the query, so the report's relative asset URLs inherit it.
      const token = encodeURIComponent(deps.signReportToken(runId));
      report = { state: 'ok', url: `/api/admin/qa/report/${runId}/${token}/index.html` };
    }
  }

  return {
    run: { ...toSummary(run), suiteSummary: run.suiteSummary ?? [], metrics: run.metrics ?? [] },
    failedTests: views.filter(v => v.status === 'failed'),
    flakyTests: views.filter(v => v.status === 'flaky'),
    report,
  };
}

export async function getQaTestHistory(testKey: string): Promise<QaTestHistory | null> {
  const results = await QaTestResult.find({ testKey }).sort({ _id: -1 }).limit(HISTORY_LIMIT).lean<IQaTestResult[]>();
  const first = results[0];
  if (!first) return null;
  const runs = await QaRun.find({ _id: { $in: results.map(r => r.runId) } }).lean<LeanRun[]>();
  const byId = new Map(runs.map(r => [String(r._id), r]));
  const rows = results.flatMap((r): QaTestHistoryRow[] => {
    const run = byId.get(r.runId);
    if (!run) return [];
    return [
      {
        runId: r.runId,
        status: r.status,
        startedAt: run.startedAt.toISOString(),
        product: run.product,
        ...(run.tenant ? { tenant: run.tenant } : {}),
        suite: run.suite,
        env: run.env,
        branch: run.branch,
        durationMs: r.durationMs,
        ...(r.error ? { error: r.error } : {}),
      },
    ];
  });
  return { testKey, title: first.title, flake: computeFlakeRate(results.map(r => r.status)), rows };
}
