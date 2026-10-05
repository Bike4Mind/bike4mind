import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// Not exported from the package dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { QaRun, QaTestResult } from '@bike4mind/database';
import type { QaRunInput } from '@bike4mind/common';
import { ingestRun } from './ingestRun';
import {
  getQaFacets,
  getQaOverview,
  getQaRunDetail,
  getQaTestHistory,
  listQaRuns,
  QA_SERIES_MAX_RUNS,
  QA_TEST_MEDIAN_LIMIT,
} from './reads';
import { failedTest, makeIngest, passedTest, TEST_A, TEST_B } from './testFixtures';
import type { QaMediaStorage } from './storage';

// Boots a real mongod, so the file runs on the shared real-Mongo budget (see MONGO_TEST_TIMEOUT_MS).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await Promise.all([QaRun.syncIndexes(), QaTestResult.syncIndexes()]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
afterEach(async () => {
  await Promise.all([QaRun.deleteMany({}), QaTestResult.deleteMany({})]);
});

const NOW = new Date('2026-09-28T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const FILTERS = { product: 'product-a', branch: 'main', rangeDays: 7 as const };
let seq = 0;

/** One run of TEST_A + TEST_B; `failing` lists the keys that fail. */
async function seed(o: Partial<QaRunInput> & { failing?: string[]; hours: number }) {
  const { failing = [], hours, ...rest } = o;
  seq += 1;
  const failed = failing.length;
  return ingestRun(
    makeIngest({
      externalRunId: `${seq}-1`,
      ciRunUrl: `https://github.com/example/repo/actions/runs/${seq}`,
      startedAt: hoursAgo(hours),
      counts: { passed: 2 - failed, failed, skipped: 0, notStarted: 0, ran: 2, total: 2 },
      tests: [TEST_A, TEST_B].map(k => (failing.includes(k) ? failedTest(k) : passedTest(k))),
      ...rest,
    })
  );
}

const storage: QaMediaStorage = {
  exists: async key => !key.includes('gone'),
  signedGetUrl: async key => `https://s3.example/${key}`,
};

describe('getQaFacets', () => {
  it('lists products, and tenants/envs/branches for the chosen product', async () => {
    await seed({ hours: 1, tenant: 'tenant-a' });
    await seed({ hours: 1, env: 'production', branch: 'feat-x' });
    await seed({ hours: 1, product: 'product-b', env: 'dev' });
    expect(await getQaFacets('product-a')).toEqual({
      products: ['product-a', 'product-b'],
      tenants: ['tenant-a'],
      envs: ['production', 'staging'],
      branches: ['feat-x', 'main'],
    });
  });
});

describe('getQaOverview', () => {
  it('builds one tile per suite/env/tenant from the latest run, with the failing streak', async () => {
    await seed({ hours: 30 });
    await seed({ hours: 20, failing: [TEST_B] });
    await seed({ hours: 10, failing: [TEST_B] });
    await seed({ hours: 5, env: 'production' });
    const { tiles } = await getQaOverview(FILTERS, NOW);
    expect(tiles.map(t => [t.suite, t.env, t.status, t.nonPassingRuns, t.failedCount])).toEqual([
      ['Core', 'production', 'passed', 0, 0],
      ['Core', 'staging', 'failed', 2, 1],
    ]);
    expect(tiles[1].failingSince).toBe(hoursAgo(20));
  });

  it('applies tenant and env filters', async () => {
    await seed({ hours: 2, tenant: 'tenant-a' });
    await seed({ hours: 2 });
    const { tiles } = await getQaOverview({ ...FILTERS, tenant: 'tenant-a' }, NOW);
    expect(tiles).toHaveLength(1);
    expect(tiles[0].tenant).toBe('tenant-a');
  });

  it('charts runs inside the range, oldest first, with a null pass rate when nothing ran', async () => {
    await seed({ hours: 24 * 8 });
    await seed({ hours: 48, failing: [TEST_B] });
    await seed({ hours: 24, counts: { passed: 0, failed: 0, skipped: 0, notStarted: 2, ran: 0, total: 0 }, tests: [] });
    const { series } = await getQaOverview(FILTERS, NOW);
    expect(series.map(p => [p.startedAt, p.passRate, p.status])).toEqual([
      [hoursAgo(48), 0.5, 'failed'],
      [hoursAgo(24), null, 'infra-error'],
    ]);
  });

  it('lists flaky tests but not always-failing ones', async () => {
    await seed({ hours: 40, failing: [TEST_A, TEST_B] });
    await seed({ hours: 30, failing: [TEST_A] });
    await seed({ hours: 20, failing: [TEST_A] });
    await seed({ hours: 10, failing: [TEST_A] });
    const { flaky } = await getQaOverview(FILTERS, NOW);
    expect(flaky).toEqual([
      { testKey: TEST_B, title: 'Notebook > saves', failures: 1, total: 4, rate: 0.25, lastStatus: 'passed' },
    ]);
  });

  it('lists a test that needed a retry on every run', async () => {
    const flakyA = { ...passedTest(TEST_A), status: 'flaky' as const, retries: 1 };
    for (const hours of [30, 20, 10]) await seed({ hours, tests: [flakyA, passedTest(TEST_B)] });
    const { flaky } = await getQaOverview(FILTERS, NOW);
    expect(flaky).toEqual([
      { testKey: TEST_A, title: 'Notebook > creates', failures: 3, total: 3, rate: 1, lastStatus: 'flaky' },
    ]);
  });

  it('keeps the newest runs when the range holds more than the series cap', async () => {
    const { tests: _tests, ...base } = makeIngest();
    const newest = new Date(hoursAgo(1)).getTime();
    await QaRun.insertMany(
      Array.from({ length: QA_SERIES_MAX_RUNS + 1 }, (_, i) => ({
        ...base,
        externalRunId: `cap-${i}`,
        startedAt: new Date(newest - i * 60_000),
        status: 'passed',
      }))
    );
    const { series } = await getQaOverview(FILTERS, NOW);
    expect(series).toHaveLength(QA_SERIES_MAX_RUNS);
    // Oldest first, and the one dropped is the oldest run.
    expect(series[series.length - 1].startedAt).toBe(new Date(newest).toISOString());
    expect(series[0].startedAt).toBe(new Date(newest - (QA_SERIES_MAX_RUNS - 1) * 60_000).toISOString());
  });
});

describe('listQaRuns', () => {
  it('pages newest first with a before cursor', async () => {
    await seed({ hours: 3 });
    await seed({ hours: 2 });
    await seed({ hours: 1 });
    const first = await listQaRuns(FILTERS, { limit: 2 });
    expect(first.runs.map(r => r.startedAt)).toEqual([hoursAgo(1), hoursAgo(2)]);
    expect(first.nextBefore).toBe(hoursAgo(2));
    const second = await listQaRuns(FILTERS, { limit: 2, before: new Date(first.nextBefore as string) });
    expect(second.runs.map(r => r.startedAt)).toEqual([hoursAgo(3)]);
    expect(second.nextBefore).toBeUndefined();
  });
});

describe('getQaRunDetail', () => {
  const withMedia = (run: number) =>
    failedTest(TEST_B, {
      artifacts: [
        { kind: 'screenshot', key: `product-a/${run}-1/media/test-1/shot.png`, bytes: 9 },
        { kind: 'video', key: `product-a/${run}-1/media/test-1/gone.webm`, bytes: 9 },
      ],
    });
  const deps = { storage, signReportToken: (id: string) => `tok-${id}`, now: NOW };

  it('signs present media, flags missing media, and links the report', async () => {
    const run = seq + 1;
    const { runId } = await seed({
      hours: 1,
      failing: [TEST_B],
      tests: [passedTest(TEST_A), withMedia(run)],
      reportPrefix: `product-a/${run}-1/report/`,
    });
    const detail = await getQaRunDetail(runId, deps);
    expect(detail?.failedTests[0].media).toEqual([
      { kind: 'screenshot', state: 'ok', url: `https://s3.example/product-a/${run}-1/media/test-1/shot.png` },
      { kind: 'video', state: 'unavailable' },
    ]);
    expect(detail?.report).toEqual({ state: 'ok', url: `/api/admin/qa/report/${runId}/tok-${runId}/index.html` });
  });

  it('marks media and report expired past the retention window without touching storage', async () => {
    const run = seq + 1;
    const { runId } = await seed({
      hours: 24 * 31,
      failing: [TEST_B],
      tests: [passedTest(TEST_A), withMedia(run)],
      reportPrefix: `product-a/${run}-1/report/`,
    });
    const throwing: QaMediaStorage = {
      exists: async () => {
        throw new Error('storage must not be called');
      },
      signedGetUrl: async () => '',
    };
    const detail = await getQaRunDetail(runId, { ...deps, storage: throwing });
    expect(detail?.failedTests[0].media.map(m => m.state)).toEqual(['expired', 'expired']);
    expect(detail?.report.state).toBe('expired');
  });

  it('returns every test without error bodies or media, which stay on the failed list', async () => {
    const run = seq + 1;
    const { runId } = await seed({
      hours: 1,
      failing: [TEST_B],
      tests: [{ ...passedTest(TEST_A), durationMs: 2500 }, withMedia(run)],
    });
    const detail = await getQaRunDetail(runId, deps);
    expect(detail?.tests.map(t => [t.testKey, t.status, t.durationMs, t.retries, t.media])).toEqual([
      [TEST_A, 'passed', 2500, 0, []],
      [TEST_B, 'failed', 1000, 2, []],
    ]);
    expect(detail?.tests.some(t => 'error' in t)).toBe(false);
    expect(detail?.failedTests).toHaveLength(1);
    expect(detail?.failedTests[0].error).toBeDefined();
    expect(detail?.failedTests[0].media).toHaveLength(2);
  });

  describe('diff against the previous run', () => {
    const GONE = 'notebook.spec.ts > Notebook > gone';
    const NEW = 'notebook.spec.ts > Notebook > new';

    it('fills newly failing, recovered, added and removed against the newest earlier run', async () => {
      await seed({ hours: 30, tests: [passedTest(TEST_A), passedTest(TEST_B)] });
      const previous = await seed({
        hours: 10,
        failing: [TEST_B],
        tests: [passedTest(TEST_A), failedTest(TEST_B), passedTest(GONE)],
      });
      const current = await seed({
        hours: 1,
        failing: [TEST_A],
        tests: [failedTest(TEST_A), passedTest(TEST_B), passedTest(NEW)],
      });
      const diff = (await getQaRunDetail(current.runId, deps))?.diff;
      expect(diff).toEqual({
        previousRunId: previous.runId,
        previousStartedAt: hoursAgo(10),
        newlyFailing: [{ testKey: TEST_A, title: 'Notebook > creates' }],
        recovered: [{ testKey: TEST_B, title: 'Notebook > saves' }],
        added: [{ testKey: NEW, title: 'Notebook > new' }],
        removed: [{ testKey: GONE, title: 'Notebook > gone' }],
      });
    });

    it('is null for the first run of a state, and ignores other states and later runs', async () => {
      const first = await seed({ hours: 10 });
      await seed({ hours: 20, env: 'production' });
      await seed({ hours: 20, tenant: 'tenant-a' });
      await seed({ hours: 5 });
      expect((await getQaRunDetail(first.runId, deps))?.diff).toBeNull();
    });

    it('skips imported runs and runs where nothing ran, and is null when only those precede', async () => {
      const imported = { source: 'slack-backfill' as const, tests: [] };
      const nothingRan = { counts: { passed: 0, failed: 0, skipped: 0, notStarted: 2, ran: 0, total: 0 }, tests: [] };
      const onlyImported = await seed({ hours: 10, ...imported });
      expect((await getQaRunDetail(onlyImported.runId, deps))?.diff).toBeNull();

      const ci = await seed({ hours: 30, failing: [TEST_B] });
      await seed({ hours: 20, ...imported });
      await seed({ hours: 15, ...nothingRan });
      const current = await seed({ hours: 12 });
      const diff = (await getQaRunDetail(current.runId, deps))?.diff;
      expect(diff?.previousRunId).toBe(ci.runId);
      expect(diff?.recovered.map(t => t.testKey)).toEqual([TEST_B]);
    });

    it('is null for an imported run, which also gets no tests or per-test medians', async () => {
      await seed({ hours: 10 });
      const imported = await seed({ hours: 1, source: 'slack-backfill', tests: [] });
      const detail = await getQaRunDetail(imported.runId, deps);
      expect(detail?.diff).toBeNull();
      expect(detail?.tests).toEqual([]);
    });
  });

  describe('duration baseline', () => {
    it('is the median of the same state in the 7 days before the run, skipping zero durations', async () => {
      await seed({ hours: 30, durationMs: 100_000 });
      await seed({ hours: 20, durationMs: 200_000 });
      await seed({ hours: 15, durationMs: 0 });
      await seed({ hours: 24 * 8, durationMs: 900_000 });
      await seed({ hours: 12, durationMs: 900_000, env: 'production' });
      await seed({ hours: 0.5, durationMs: 5_000_000 });
      const current = await seed({ hours: 1, durationMs: 999_999 });
      expect((await getQaRunDetail(current.runId, deps))?.medianDurationMs).toBe(150_000);
    });

    it('averages the middle two of an even count and is null with no baseline', async () => {
      await seed({ hours: 30, durationMs: 100_000 });
      await seed({ hours: 20, durationMs: 101_000 });
      const current = await seed({ hours: 1 });
      const first = await seed({ hours: 24 * 9, env: 'staging-2' });
      expect((await getQaRunDetail(current.runId, deps))?.medianDurationMs).toBe(100_500);
      expect((await getQaRunDetail(first.runId, deps))?.medianDurationMs).toBeNull();
    });

    it('gives the slowest tests a median over passed, non-zero results of earlier runs', async () => {
      const timed = (key: string, durationMs: number, status: 'passed' | 'failed' = 'passed') => ({
        ...(status === 'failed' ? failedTest(key) : passedTest(key)),
        durationMs,
      });
      await seed({ hours: 30, tests: [timed(TEST_A, 1000), timed(TEST_B, 400)] });
      await seed({ hours: 20, tests: [timed(TEST_A, 3000), timed(TEST_B, 0)] });
      await seed({ hours: 15, failing: [TEST_A], tests: [timed(TEST_A, 60_000, 'failed'), passedTest(TEST_B)] });
      await seed({ hours: 12, env: 'production', tests: [timed(TEST_A, 90_000)] });
      const current = await seed({ hours: 1, tests: [timed(TEST_A, 5000), timed(TEST_B, 500)] });
      const detail = await getQaRunDetail(current.runId, deps);
      expect(detail?.tests.map(t => [t.testKey, t.medianMs])).toEqual([
        [TEST_A, 2000],
        [TEST_B, 700],
      ]);
    });

    it('computes per-test medians only for the slowest tests of the run', async () => {
      const bulk = (durationMs: (i: number) => number) =>
        Array.from({ length: QA_TEST_MEDIAN_LIMIT + 2 }, (_, i) => ({
          ...passedTest(`bulk.spec.ts > Bulk > t${i}`),
          durationMs: durationMs(i),
        }));
      await seed({ hours: 20, tests: bulk(() => 500) });
      const current = await seed({ hours: 1, tests: bulk(i => 1000 + i) });
      const detail = await getQaRunDetail(current.runId, deps);
      const withMedian = detail?.tests.filter(t => t.medianMs !== undefined) ?? [];
      expect(withMedian).toHaveLength(QA_TEST_MEDIAN_LIMIT);
      expect(detail?.tests.filter(t => t.medianMs === undefined).map(t => t.title)).toEqual(['Bulk > t0', 'Bulk > t1']);
    });
  });

  it('returns null for an unknown run', async () => {
    expect(await getQaRunDetail(new mongoose.Types.ObjectId().toHexString(), deps)).toBeNull();
  });
});

describe('getQaTestHistory', () => {
  it('returns newest-first results with the flake rate', async () => {
    await seed({ hours: 3, failing: [TEST_B] });
    await seed({ hours: 2 });
    await seed({ hours: 1 });
    const history = await getQaTestHistory(TEST_B);
    expect(history?.rows.map(r => [r.startedAt, r.status])).toEqual([
      [hoursAgo(1), 'passed'],
      [hoursAgo(2), 'passed'],
      [hoursAgo(3), 'failed'],
    ]);
    expect(history?.flake).toEqual({ failures: 1, total: 3, rate: 1 / 3 });
  });
  it('returns null for an unknown test', async () => {
    expect(await getQaTestHistory('nope')).toBeNull();
  });
});
