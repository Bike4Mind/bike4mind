import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMocks } from 'node-mocks-http';
// Not exported from the package dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';
import { QaRun, QaTestResult } from '@bike4mind/database';
import { ApiKeyScope, QA_INGEST_USER_TAG, type QaRunIngestRequest } from '@bike4mind/common';
import { makeIngestRequest, TEST_A, TEST_B } from '@server/qa/testFixtures';

const { mockSlackPost } = vi.hoisted(() => ({ mockSlackPost: vi.fn() }));

// Real ingestRun + evaluateAlarm against Mongo; baseApi is stubbed and Slack (axios) is mocked.
vi.mock('@server/middlewares/baseApi', () => import('@server/qa/testing/baseApiStub'));
vi.mock('axios', async importOriginal => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, post: (...a: unknown[]) => mockSlackPost(...a) } };
});
vi.mock('@server/utils/config', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/utils/config')>();
  return {
    ...actual,
    Config: { ...actual.Config, QA_ALARM_SLACK_WEBHOOKS: '{"product-a":"https://hooks.example.com/a"}' },
  };
});

import handler from '../runs';

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
beforeEach(() => {
  vi.clearAllMocks();
  mockSlackPost.mockResolvedValue({ status: 200 });
  vi.stubEnv('APP_URL', 'https://app.example.com');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all([QaRun.deleteMany({}), QaTestResult.deleteMany({})]);
});

const KEY = { keyId: 'k1', scopes: [ApiKeyScope.QA_INGEST] };
const OWNER = { id: 'svc', tags: [QA_INGEST_USER_TAG] };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const call = async (body: unknown) => {
  const { req, res } = createMocks({ method: 'POST', body, headers: { host: 'app.example.com' } });
  Object.assign(req, { apiKeyInfo: KEY, user: OWNER, logger });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { status: res._getStatusCode(), json: res._getJSONData() };
};

/** Wire-shape run; `failing` lists the keys that fail. */
const run = (id: string, hour: number, failing: string[] = [], o: Partial<QaRunIngestRequest> = {}) =>
  makeIngestRequest({
    external_run_id: id,
    started_at: new Date(Date.UTC(2026, 8, 28, hour)).toISOString(),
    counts: { passed: 2 - failing.length, failed: failing.length, skipped: 0, not_started: 0, ran: 2, total: 2 },
    tests: [TEST_A, TEST_B].map(test_key => ({
      test_key,
      title: test_key.split(' > ').slice(1).join(' > '),
      status: failing.includes(test_key) ? ('failed' as const) : ('passed' as const),
      duration_ms: 1000,
      retries: 0,
      artifacts: [],
    })),
    ...o,
  });

describe('POST /api/qa/runs alarm (real ingest)', () => {
  it('posts a state change once, and never again on re-ingest of the same run', async () => {
    expect((await call(run('1-1', 1))).status).toBe(200);
    expect(mockSlackPost).not.toHaveBeenCalled();

    const first = await call(run('2-1', 2, [TEST_B]));
    expect(first.json).toMatchObject({ status: 'failed', created: true });
    expect(mockSlackPost).toHaveBeenCalledTimes(1);
    expect(mockSlackPost).toHaveBeenCalledWith(
      'https://hooks.example.com/a',
      {
        text: `Core . staging failing: 1 test (Notebook &gt; saves) <https://app.example.com/status/runs/${first.json.run_id}|view run>`,
      },
      { timeout: 5000 }
    );

    const again = await call(run('2-1', 2, [TEST_B]));
    expect(again.json).toEqual({ run_id: first.json.run_id, status: 'failed', created: false });
    expect(mockSlackPost).toHaveBeenCalledTimes(1);
    expect(await QaRun.countDocuments({})).toBe(2);
  });

  it('alarms on the re-ingest that follows a failed Slack post, then never again', async () => {
    mockSlackPost.mockRejectedValueOnce(new Error('slack down'));
    expect((await call(run('1-1', 1, [TEST_B]))).json).toMatchObject({ created: true });
    expect(mockSlackPost).toHaveBeenCalledTimes(1);
    expect((await call(run('1-1', 1, [TEST_B]))).json).toMatchObject({ created: false });
    expect(mockSlackPost).toHaveBeenCalledTimes(2);
    await call(run('1-1', 1, [TEST_B]));
    expect(mockSlackPost).toHaveBeenCalledTimes(2);
  });

  it('alarms on the re-ingest that follows a failure before the post', async () => {
    const find = vi.spyOn(QaTestResult, 'find').mockImplementationOnce(() => {
      throw new Error('lookup failed');
    });
    expect((await call(run('1-1', 1, [TEST_B]))).status).toBe(200);
    find.mockRestore();
    expect(mockSlackPost).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('lookup failed'));
    await call(run('1-1', 1, [TEST_B]));
    expect(mockSlackPost).toHaveBeenCalledTimes(1);
  });

  it('posts once when the same run is ingested twice concurrently', async () => {
    const [a, b] = await Promise.all([call(run('1-1', 1, [TEST_B])), call(run('1-1', 1, [TEST_B]))]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(mockSlackPost).toHaveBeenCalledTimes(1);
    expect(await QaTestResult.countDocuments({ runId: a.json.run_id })).toBe(2);
  });

  it('stores a feature-branch failure without posting', async () => {
    expect((await call(run('1-1', 1, [TEST_B], { branch: 'feat-x' }))).json).toMatchObject({ created: true });
    expect(mockSlackPost).not.toHaveBeenCalled();
    expect(await QaRun.countDocuments({ branch: 'feat-x' })).toBe(1);
  });

  it('logs and skips a product with no webhook', async () => {
    expect((await call(run('1-1', 1, [TEST_B], { product: 'product-b' }))).status).toBe(200);
    expect(mockSlackPost).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('no webhook for product-b'));
  });

  it('keeps the run and returns 200 when Slack fails', async () => {
    mockSlackPost.mockRejectedValueOnce(new Error('slack down'));
    const res = await call(run('1-1', 1, [TEST_B]));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: 'failed', created: true });
    expect(await QaRun.countDocuments({})).toBe(1);
    expect(await QaTestResult.countDocuments({ runId: res.json.run_id })).toBe(2);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('alarm failed'));
  });
});
