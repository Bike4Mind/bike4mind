import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// Not exported from the package dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { QaRun, QaTestResult } from '@bike4mind/database';
import type { QaRunInput } from '@bike4mind/common';

vi.mock('@server/utils/config', () => ({ Config: { QA_ALARM_SLACK_WEBHOOKS: undefined } }));

import { ingestRun } from './ingestRun';
import { evaluateAlarm, type AlarmDeps } from './evaluateAlarm';
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

/** Ingest one run of TEST_A + TEST_B and evaluate it, as the route does on first ingest. */
async function step(deps: AlarmDeps, o: { failing?: string[]; down?: boolean } & Partial<QaRunInput> = {}) {
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
  return evaluateAlarm(runId, deps);
}

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
