import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope, QA_INGEST_USER_TAG } from '@bike4mind/common';
import { makeIngestRequest } from '@server/qa/testFixtures';

const { mockIngest } = vi.hoisted(() => ({ mockIngest: vi.fn() }));

// baseApi is stubbed (no auth chain); the real nextRouteForContract prelude and errorHandler run.
vi.mock('@server/middlewares/baseApi', () => import('@server/qa/testing/baseApiStub'));
vi.mock('@server/qa/ingestRun', () => ({ ingestRun: (...a: unknown[]) => mockIngest(...a) }));

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
});

describe('POST /api/v1/qa/runs', () => {
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
    // The contract's response drift check stays quiet.
    expect(logger.warn).not.toHaveBeenCalled();
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
