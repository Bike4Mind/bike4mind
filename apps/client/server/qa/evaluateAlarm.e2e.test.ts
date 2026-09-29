import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// Not exported from the package dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { QaRun, QaTestResult } from '@bike4mind/database';
import type { QaRunInput } from '@bike4mind/common';

vi.mock('@server/utils/config', () => ({ Config: { QA_ALARM_SLACK_WEBHOOKS: undefined } }));

import { ingestRun } from './ingestRun';
import { ALARM_CLAIM_STALE_MS, evaluateAlarm, type AlarmDeps } from './evaluateAlarm';
import { failedTest, makeIngest, passedTest, TEST_A, TEST_B } from './testFixtures';

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

let seq = 0;
const DOWN = { passed: 0, failed: 0, skipped: 0, notStarted: 90, ran: 0, total: 0 };

type StepOpts = { failing?: string[]; down?: boolean } & Partial<QaRunInput>;

/** Ingest one run of TEST_A + TEST_B without evaluating it. */
async function ingest(o: StepOpts = {}) {
  const { failing = [], down = false, ...rest } = o;
  seq += 1;
  const { runId, created } = await ingestRun(
    makeIngest({
      externalRunId: `${seq}-1`,
      startedAt: new Date(Date.UTC(2026, 8, 1) + seq * 3_600_000).toISOString(),
      counts: down
        ? DOWN
        : { passed: 2 - failing.length, failed: failing.length, skipped: 0, notStarted: 0, ran: 2, total: 2 },
      tests: down ? [] : [TEST_A, TEST_B].map(k => (failing.includes(k) ? failedTest(k) : passedTest(k))),
      ...rest,
    })
  );
  expect(created).toBe(true);
  return runId;
}

/** Ingest one run and evaluate it, as the route does. */
async function step(deps: AlarmDeps, o: StepOpts = {}) {
  return evaluateAlarm(await ingest(o), deps);
}

const hour = (h: number) => new Date(Date.UTC(2026, 7, 1, h)).toISOString();

const makeDeps = () => {
  const post = vi.fn<AlarmDeps['post']>(async () => {});
  const log = vi.fn<AlarmDeps['log']>();
  const deps: AlarmDeps = {
    post,
    webhookFor: product => (product === 'product-a' ? 'https://hooks.example.com/a' : undefined),
    appOrigin: 'https://app.example.com',
    log,
  };
  return { deps, post, log };
};

describe('evaluateAlarm', () => {
  it('runs the spec scenario R1..R7', async () => {
    const { deps, post } = makeDeps();
    expect(await step(deps)).toBeNull(); // R1 passes
    expect(await step(deps, { failing: [TEST_B] })).toMatch(
      /^Core \. staging failing: 1 test \(Notebook &gt; saves\) </
    ); // R2
    expect(await step(deps, { failing: [TEST_B] })).toBeNull(); // R3 same failure
    expect(await step(deps, { failing: [TEST_A, TEST_B] })).toMatch(/now also failing: Notebook &gt; creates </); // R4
    expect(await step(deps, { down: true })).toMatch(/env down: 0 of 90 ran </); // R5
    expect(await step(deps, { down: true })).toBeNull(); // R6 still down
    expect(await step(deps)).toMatch(/recovered after 5 runs </); // R7
    expect(post).toHaveBeenCalledTimes(4);
    expect(post.mock.calls[0][0]).toBe('https://hooks.example.com/a');
    expect(post.mock.calls[0][1]).toMatch(/<https:\/\/app\.example\.com\/status\/runs\/[a-f0-9]{24}\|view run>$/);
  });

  it('alarms on a first-ever failing run', async () => {
    const { deps, post } = makeDeps();
    expect(await step(deps, { failing: [TEST_B] })).toMatch(/^Core \. staging failing: 1 test/);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('stores but never posts a feature-branch run, and never compares against one', async () => {
    const { deps, post } = makeDeps();
    await step(deps);
    expect(await step(deps, { failing: [TEST_B], branch: 'feat-x' })).toBeNull();
    expect(await step(deps, { down: true, branch: 'feat-x' })).toBeNull();
    expect(post).not.toHaveBeenCalled();
    expect(await QaRun.countDocuments({ branch: 'feat-x' })).toBe(2);
    // Previous is the main pass, not the feature-branch infra-error.
    expect(await step(deps, { failing: [TEST_B] })).toMatch(/failing: 1 test \(Notebook &gt; saves\)/);
  });

  it('ignores backfilled runs as current and as previous', async () => {
    const { deps } = makeDeps();
    expect(await step(deps, { failing: [TEST_B], source: 'slack-backfill' })).toBeNull();
    // No earlier CI run, so this failure alarms as first-after-pass.
    expect(await step(deps, { failing: [TEST_B] })).toMatch(/failing: 1 test/);
  });

  it('keeps products apart: another product is never the previous run', async () => {
    const { deps } = makeDeps();
    await step(deps, { product: 'product-b', failing: [TEST_B] });
    expect(await step(deps, { failing: [TEST_B] })).toMatch(/failing: 1 test/);
  });

  it('logs and skips, never throws, when the product has no webhook', async () => {
    const { deps, post, log } = makeDeps();
    expect(await step(deps, { product: 'product-b', failing: [TEST_B] })).toMatch(/failing/);
    expect(post).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no webhook for product-b'));
  });

  it('propagates a Slack failure to the caller, after the run is stored', async () => {
    const { deps, post } = makeDeps();
    post.mockRejectedValueOnce(new Error('slack down'));
    await expect(step(deps, { failing: [TEST_B] })).rejects.toThrow('slack down');
    expect(await QaRun.countDocuments({})).toBe(1);
  });
});

describe('evaluateAlarm: known flaky', () => {
  it('tags a test that failed in at least 15% of its prior results on this state key', async () => {
    const { deps } = makeDeps();
    await step(deps, { failing: [TEST_B] });
    for (let i = 0; i < 4; i++) await step(deps);
    // History for saves: 1 failure in 5 prior results = 20%.
    expect(await step(deps, { failing: [TEST_B] })).toContain('(Notebook &gt; saves (known flaky))');
  });

  it('never tags a first failure', async () => {
    const { deps } = makeDeps();
    for (let i = 0; i < 5; i++) await step(deps);
    expect(await step(deps, { failing: [TEST_B] })).toContain('(Notebook &gt; saves) <');
  });

  it('ignores the same test key failing under another product', async () => {
    const { deps } = makeDeps();
    await step(deps, { product: 'product-b', failing: [TEST_B] });
    for (let i = 0; i < 4; i++) await step(deps, { product: 'product-b' });
    await step(deps);
    expect(await step(deps, { failing: [TEST_B] })).toContain('(Notebook &gt; saves) <');
  });

  it('tags the newly failing test in a "now also failing" post', async () => {
    const { deps } = makeDeps();
    await step(deps, { failing: [TEST_A] });
    for (let i = 0; i < 3; i++) await step(deps);
    await step(deps, { failing: [TEST_B] });
    // creates: 1 failure in 5 prior results.
    expect(await step(deps, { failing: [TEST_A, TEST_B] })).toContain(
      'now also failing: Notebook &gt; creates (known flaky) <'
    );
  });
});

describe('evaluateAlarm: once per run', () => {
  it('never re-posts a run it already alarmed on', async () => {
    const { deps, post } = makeDeps();
    const runId = await ingest({ failing: [TEST_B] });
    expect(await evaluateAlarm(runId, deps)).toMatch(/failing: 1 test/);
    expect(await evaluateAlarm(runId, deps)).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
    expect((await QaRun.findById(runId).lean())?.alarmEvaluatedAt).toBeInstanceOf(Date);
  });

  it('posts once when two ingests evaluate the same run concurrently', async () => {
    const { deps, post } = makeDeps();
    const runId = await ingest({ failing: [TEST_B] });
    const results = await Promise.all([evaluateAlarm(runId, deps), evaluateAlarm(runId, deps)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('alarms on the retry after a Slack failure, then never again', async () => {
    const { deps, post } = makeDeps();
    post.mockRejectedValueOnce(new Error('slack down'));
    const runId = await ingest({ failing: [TEST_B] });
    await expect(evaluateAlarm(runId, deps)).rejects.toThrow('slack down');
    expect(await evaluateAlarm(runId, deps)).toMatch(/failing: 1 test/);
    expect(await evaluateAlarm(runId, deps)).toBeNull();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('alarms on the retry after a failure before the post', async () => {
    const { deps, post } = makeDeps();
    const runId = await ingest({ failing: [TEST_B] });
    const find = vi.spyOn(QaTestResult, 'find').mockImplementationOnce(() => {
      throw new Error('lookup failed');
    });
    await expect(evaluateAlarm(runId, deps)).rejects.toThrow('lookup failed');
    find.mockRestore();
    expect(post).not.toHaveBeenCalled();
    expect(await evaluateAlarm(runId, deps)).toMatch(/failing: 1 test/);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('takes over the claim of a crashed attempt only once it is stale', async () => {
    const { deps, post } = makeDeps();
    const runId = await ingest({ failing: [TEST_B] });
    await QaRun.updateOne({ _id: runId }, { $set: { alarmClaimedAt: new Date(Date.now() - 1000) } });
    expect(await evaluateAlarm(runId, deps)).toBeNull();
    expect(post).not.toHaveBeenCalled();
    await QaRun.updateOne(
      { _id: runId },
      { $set: { alarmClaimedAt: new Date(Date.now() - ALARM_CLAIM_STALE_MS - 1000) } }
    );
    expect(await evaluateAlarm(runId, deps)).toMatch(/failing: 1 test/);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('never posts once its own claim could have gone stale, and frees it for a retry', async () => {
    const { deps, post } = makeDeps();
    const runId = await ingest({ failing: [TEST_B] });
    const start = Date.now();
    let calls = 0;
    // First call stamps the claim; every later one is a clock past the post deadline.
    const slow: AlarmDeps = { ...deps, now: () => new Date(start + (calls++ === 0 ? 0 : ALARM_CLAIM_STALE_MS)) };
    await expect(evaluateAlarm(runId, slow)).rejects.toThrow(/claim/);
    expect(post).not.toHaveBeenCalled();
    expect(await evaluateAlarm(runId, deps)).toMatch(/failing: 1 test/);
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('evaluateAlarm: out-of-order ingest', () => {
  it('stays quiet for a run ingested after a newer one on the same key', async () => {
    const { deps, post } = makeDeps();
    expect(await step(deps, { failing: [TEST_B], startedAt: hour(1) })).toMatch(/failing: 1 test/); // R1
    expect(await step(deps, { failing: [TEST_B], startedAt: hour(3) })).toBeNull(); // R3, same failure
    // R2 started before R3 but finished last: "recovered" would contradict the newest state.
    const r2 = await ingest({ startedAt: hour(2) });
    expect(await evaluateAlarm(r2, deps)).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
    expect((await QaRun.findById(r2).lean())?.alarmEvaluatedAt).toBeInstanceOf(Date);
  });

  it('still alarms when the only newer run is on another branch or backfilled', async () => {
    const { deps } = makeDeps();
    await step(deps, { startedAt: hour(1) });
    await ingest({ failing: [TEST_B], startedAt: hour(3), branch: 'feat-x' });
    await ingest({ failing: [TEST_B], startedAt: hour(4), source: 'slack-backfill' });
    expect(await step(deps, { failing: [TEST_B], startedAt: hour(2) })).toMatch(/failing: 1 test/);
  });
});
