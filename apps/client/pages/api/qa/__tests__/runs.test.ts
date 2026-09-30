import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope, QA_INGEST_USER_TAG } from '@bike4mind/common';
import { makeIngestRequest } from '@server/qa/testFixtures';

const { mockIngest, mockEvaluate } = vi.hoisted(() => ({ mockIngest: vi.fn(), mockEvaluate: vi.fn() }));

// baseApi is stubbed (no auth chain); the real errorHandler runs.
vi.mock('@server/middlewares/baseApi', () => import('@server/qa/testing/baseApiStub'));
vi.mock('@server/qa/ingestRun', () => ({ ingestRun: (...a: unknown[]) => mockIngest(...a) }));
vi.mock('@server/qa/evaluateAlarm', () => ({
  evaluateAlarm: (...a: unknown[]) => mockEvaluate(...a),
  defaultAlarmDeps: () => ({ deps: 'default' }),
}));

import { baseApiOptions } from '@server/qa/testing/baseApiStub';
import handler, { config } from '../runs';

const KEY = { keyId: 'k1', scopes: [ApiKeyScope.QA_INGEST] };
const OWNER = { id: 'svc', tags: [QA_INGEST_USER_TAG] };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const call = async (body: unknown, auth: Record<string, unknown> = { apiKeyInfo: KEY, user: OWNER }) => {
  const { req, res } = createMocks({ method: 'POST', body, headers: { host: 'app.example.com' } });
  Object.assign(req, auth, { logger });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { status: res._getStatusCode(), json: res._getJSONData() };
};

beforeEach(() => {
  vi.clearAllMocks();
  mockIngest.mockResolvedValue({ runId: 'r1', status: 'passed', created: true });
  mockEvaluate.mockResolvedValue(null);
});

describe('POST /api/qa/runs', () => {
  it('declares the qa:ingest scope gate, which is what admits the confined key', () => {
    expect(baseApiOptions).toContainEqual(expect.objectContaining({ requiredScopes: [ApiKeyScope.QA_INGEST] }));
  });
  it('ingests a valid run', async () => {
    const { status, json } = await call(makeIngestRequest());
    expect(status).toBe(200);
    expect(json).toEqual({ run_id: 'r1', status: 'passed', created: true });
    expect(mockIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        externalRunId: '100-1',
        source: 'ci',
        ciRunUrl: 'https://github.com/example/repo/actions/runs/100',
        counts: expect.objectContaining({ notStarted: 0 }),
      })
    );
  });
  it('401s a JWT-only caller', async () => {
    expect((await call(makeIngestRequest(), { user: OWNER })).status).toBe(401);
    expect(mockIngest).not.toHaveBeenCalled();
  });
  it('403s a key without qa:ingest', async () => {
    const auth = { apiKeyInfo: { keyId: 'k', scopes: [ApiKeyScope.AI_CHAT] }, user: OWNER };
    expect((await call(makeIngestRequest(), auth)).status).toBe(403);
  });
  it('403s an untagged key owner', async () => {
    expect((await call(makeIngestRequest(), { apiKeyInfo: KEY, user: { id: 'u', tags: [] } })).status).toBe(403);
  });
  it('422s and names the missing field', async () => {
    const { product: _omit, ...rest } = makeIngestRequest();
    const { status, json } = await call(rest);
    expect(status).toBe(422);
    expect(json.error).toContain('product');
  });
  it('raises the body limit for large runs', () => {
    expect(config.api.bodyParser.sizeLimit).toBe('4mb');
  });
});

describe('POST /api/qa/runs alarm wiring', () => {
  it('evaluates the alarm after a first ingest', async () => {
    await call(makeIngestRequest());
    expect(mockEvaluate).toHaveBeenCalledWith('r1', { deps: 'default' });
    expect(mockIngest.mock.invocationCallOrder[0]).toBeLessThan(mockEvaluate.mock.invocationCallOrder[0]);
  });
  it('evaluates a re-ingested run too: evaluateAlarm owns once-per-run', async () => {
    mockIngest.mockResolvedValueOnce({ runId: 'r1', status: 'failed', created: false });
    expect((await call(makeIngestRequest())).status).toBe(200);
    expect(mockEvaluate).toHaveBeenCalledWith('r1', { deps: 'default' });
  });
  it('returns 503 and logs when the alarm throws', async () => {
    mockEvaluate.mockRejectedValueOnce(new Error('slack down'));
    const { status, json } = await call(makeIngestRequest());
    expect(status).toBe(503);
    expect(json).toEqual({
      run_id: 'r1',
      status: 'passed',
      created: true,
      error: 'alarm evaluation failed; retry',
    });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('alarm failed for run=r1: slack down'));
  });
  it('never evaluates a rejected payload', async () => {
    const { product: _omit, ...rest } = makeIngestRequest();
    expect((await call(rest)).status).toBe(422);
    expect(mockEvaluate).not.toHaveBeenCalled();
  });
});
