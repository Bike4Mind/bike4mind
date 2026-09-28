import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// Not exported from the package dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { QaRun, QaTestResult } from '@bike4mind/database';
import { QaRunIngestRequestSchema, qaRunFromWire } from '@bike4mind/common';
import { ingestRun } from './ingestRun';
// The backfill CLI and its synthetic posts are untyped .mjs outside every workspace (test files are not type-checked).
import { parseSlackPost } from '../../../../scripts/qa-backfill-slack.mjs';
import { CHANNEL, e2ePost, latencyPost } from '../../../../scripts/__tests__/fixtures/slack-posts.mjs';

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

/** The path POST /api/v1/qa/runs takes: contract validation, wire mapping, ingest. */
const ingestPost = (message: unknown) => {
  const body = parseSlackPost(message, { product: 'product-a', channel: CHANNEL });
  return ingestRun(qaRunFromWire(QaRunIngestRequestSchema.parse(body)));
};

describe('Slack backfill through the ingest path', () => {
  it('stores an E2E post as a slack-backfill run with no tests or media', async () => {
    const res = await ingestPost(e2ePost());
    expect(res).toMatchObject({ status: 'failed', created: true });
    const run = await QaRun.findById(res.runId).lean();
    expect(run).toMatchObject({
      externalRunId: `slack-${CHANNEL}-1790000000.000100`,
      source: 'slack-backfill',
      suite: 'Core',
      env: 'staging',
      counts: { passed: 81, failed: 1, notStarted: 0, ran: 82, total: 82 },
    });
    expect(run?.suiteSummary).toHaveLength(3);
    expect(run?.metrics.map(m => m.model)).toEqual(['model-x', 'Model Y Mini']);
    expect(run?.reportPrefix).toBeUndefined();
    expect(await QaTestResult.countDocuments({ runId: res.runId })).toBe(0);
  });

  it('stores an AI Latency post with its latency metrics', async () => {
    const res = await ingestPost(latencyPost());
    const run = await QaRun.findById(res.runId).lean();
    expect(run).toMatchObject({ suite: 'AI Latency', source: 'slack-backfill', status: 'failed' });
    expect(run?.metrics.every(m => m.kind === 'latency')).toBe(true);
    expect(run?.metrics).toHaveLength(3);
  });

  it('upserts the same run when the backfill is re-run', async () => {
    const first = await ingestPost(e2ePost());
    const second = await ingestPost(e2ePost());
    expect(second).toEqual({ ...first, created: false });
    expect(await QaRun.countDocuments({})).toBe(1);
  });
});
