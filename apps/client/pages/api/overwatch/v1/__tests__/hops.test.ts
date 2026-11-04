// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// baseApi's chain, reduced to what the route uses: .use() for the rate limit, .post() for the
// handler. The real chain (key validation, scope gate) is covered for this scope by the events
// integration test and the lockstep scan; here the handler's own checks are under test.
const { baseApiOptions, rateLimitOptions } = vi.hoisted(() => ({
  baseApiOptions: [] as unknown[],
  rateLimitOptions: [] as unknown[],
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (opts: unknown) => {
    baseApiOptions.push(opts);
    const api = {
      use: () => api,
      post: (fn: (req: unknown, res: unknown) => unknown) => fn,
    };
    return api;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (opts: unknown) => {
    rateLimitOptions.push(opts);
    return () => undefined;
  },
}));

const { config, mockSendBatch, mockEmitMetric, mockCreate } = vi.hoisted(() => ({
  config: { OVERWATCH_INGEST_ENABLED: 'true', OVERWATCH_PSEUDONYM_SALT: 'test-salt', STAGE: 'test' } as Record<
    string,
    string | undefined
  >,
  mockSendBatch: vi.fn(),
  mockEmitMetric: vi.fn(),
  mockCreate: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: config }));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ sendBatchToQueue: (...a: unknown[]) => mockSendBatch(...a) }));
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({ emitMetric: (...a: unknown[]) => mockEmitMetric(...a) }));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({ getSourceQueueUrl: () => 'queue-url' }));
vi.mock('@bike4mind/database', () => ({ analyticsHopRepository: { create: (...a: unknown[]) => mockCreate(...a) } }));

import handler from '../hops';
import { ApiKeyScope, OverwatchAnalyticsEventSchema } from '@bike4mind/common';
import { deriveHopKey, verifyHopToken } from '@server/analytics/hopToken';

const SOURCE = 'source-product';
const TOKEN_SHAPE = /^[0-9a-f]{32}\.\d+\.[A-Za-z0-9_-]{43}$/;

function call({
  body = { dest: 'bike4mind' } as unknown,
  apiKeyInfo = {
    scopes: [ApiKeyScope.OVERWATCH_INGEST_WRITE],
    productId: SOURCE,
    keyId: 'key-1',
  } as unknown,
} = {}) {
  const { req, res } = createMocks({ method: 'POST', body: body as Record<string, unknown> });
  // null: no key at all (a session caller).
  if (apiKeyInfo !== null) (req as unknown as { apiKeyInfo: unknown }).apiKeyInfo = apiKeyInfo;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  (req as unknown as { logger: unknown }).logger = logger;
  const run = () => (handler as unknown as (q: unknown, s: unknown) => Promise<unknown>)(req, res);
  return { req, res, logger, run };
}

const status = (res: unknown) => (res as { _getStatusCode: () => number })._getStatusCode();
const json = (res: unknown) => (res as { _getJSONData: () => Record<string, unknown> })._getJSONData();

describe('POST /api/overwatch/v1/hops', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.OVERWATCH_INGEST_ENABLED = 'true';
    config.OVERWATCH_PSEUDONYM_SALT = 'test-salt';
    delete process.env.APP_URL;
    mockCreate.mockImplementation(async (input: Record<string, unknown>) => ({
      _id: 'id',
      redeemedAt: null,
      ...input,
    }));
    mockSendBatch.mockResolvedValue([{ index: 0, success: true }]);
    mockEmitMetric.mockResolvedValue(undefined);
  });

  it('is gated on the ingest scope, POST only, with a per-key mint limit', () => {
    expect(baseApiOptions[0]).toMatchObject({
      requiredScopes: [ApiKeyScope.OVERWATCH_INGEST_WRITE],
      allowedMethods: ['POST'],
    });
    const limit = rateLimitOptions[0] as { limit: number; bucket: string; subject: (r: unknown) => unknown };
    expect(limit.bucket).toBe('overwatch-hops-mint');
    expect(limit.subject({ apiKeyInfo: { keyId: 'key-1' } })).toBe('key-1');
  });

  it('mints a hop for the key product and returns its token', async () => {
    process.env.APP_URL = 'https://app.example.com';
    const { res, run, logger } = call({ body: { dest: 'bike4mind', path: '/new', srcSessionId: 's1' } });
    await run();

    expect(status(res)).toBe(201);
    expect((res as unknown as { getHeader: (n: string) => unknown }).getHeader('Cache-Control')).toBe('no-store');
    const body = json(res);
    expect(body.token).toMatch(TOKEN_SHAPE);
    expect(String(body.token).startsWith(`${body.hopId}.`)).toBe(true);
    const ttl = (new Date(String(body.expiresAt)).getTime() - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
    expect(body.url).toBe(`https://app.example.com/new?b4m_hop=${body.token}`);
    expect(
      verifyHopToken(deriveHopKey('test-salt'), body.token, { dest: 'bike4mind', nowSeconds: Date.now() / 1000 }).ok
    ).toBe(true);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ hopId: body.hopId, srcProductId: SOURCE, dest: 'bike4mind', path: '/new' })
    );
    // The token is returned to the caller, never logged.
    expect(JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls])).not.toContain(String(body.token));
  });

  it('emits hop_minted onto the ingest queue under the key product', async () => {
    const { res, run } = call({ body: { dest: 'bike4mind', lane: 'synthetic', srcSessionId: 's1' } });
    await run();

    expect(mockSendBatch).toHaveBeenCalledOnce();
    const [queueUrl, events] = mockSendBatch.mock.calls[0] as [string, Record<string, unknown>[]];
    expect(queueUrl).toBe('queue-url');
    expect(events).toHaveLength(1);
    expect(OverwatchAnalyticsEventSchema.safeParse(events[0]).success).toBe(true);
    expect(events[0]).toMatchObject({
      productId: SOURCE,
      event: 'hop_minted',
      sessionId: 's1',
      metadata: { hopId: json(res).hopId, dest: 'bike4mind', lane: 'synthetic' },
    });
  });

  it('refuses a body that names a source, so no key can mint as another product', async () => {
    const { res, run } = call({ body: { dest: 'bike4mind', srcProductId: 'another-product' } });
    await run();
    expect(status(res)).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSendBatch).not.toHaveBeenCalled();
  });

  it('refuses a destination that cannot redeem', async () => {
    const { res, run } = call({ body: { dest: 'another-product' } });
    await run();
    expect(status(res)).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('refuses a hop from a product to itself', async () => {
    const { res, run } = call({
      apiKeyInfo: { scopes: [ApiKeyScope.OVERWATCH_INGEST_WRITE], productId: 'bike4mind', keyId: 'k' },
    });
    await run();
    expect(status(res)).toBe(400);
    expect(json(res).error).toBe('A product cannot hop to itself');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('requires an API key', async () => {
    const { res, run } = call({ apiKeyInfo: null });
    await run();
    expect(status(res)).toBe(401);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('requires the ingest scope', async () => {
    const { res, run } = call({ apiKeyInfo: { scopes: [ApiKeyScope.AI_CHAT], productId: SOURCE, keyId: 'k' } });
    await run();
    expect(status(res)).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('requires a key bound to a product', async () => {
    const { res, run } = call({ apiKeyInfo: { scopes: [ApiKeyScope.OVERWATCH_INGEST_WRITE], keyId: 'k' } });
    await run();
    expect(status(res)).toBe(403);
    expect(json(res).error).toBe('Key not bound to a product');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('honours the ingest kill switch', async () => {
    config.OVERWATCH_INGEST_ENABLED = 'false';
    const { res, run } = call();
    await run();
    expect(status(res)).toBe(503);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('mints nothing when this deployment has no hop key', async () => {
    config.OVERWATCH_PSEUDONYM_SALT = 'not-configured';
    const { res, run } = call();
    await run();
    expect(status(res)).toBe(503);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSendBatch).not.toHaveBeenCalled();
  });

  it('still returns the token when hop_minted cannot be queued, and counts the loss', async () => {
    mockSendBatch.mockResolvedValue([{ index: 0, success: false, error: 'throttled' }]);
    const failed = call();
    await failed.run();
    expect(status(failed.res)).toBe(201);
    expect(json(failed.res).token).toMatch(TOKEN_SHAPE);
    expect(mockEmitMetric).toHaveBeenCalledWith('Lumina5/Analytics', 'IngestEmitFailed', 1, { Stage: 'test' });

    mockEmitMetric.mockClear();
    mockSendBatch.mockRejectedValue(new Error('network'));
    const threw = call();
    await threw.run();
    expect(status(threw.res)).toBe(201);
    expect(mockEmitMetric).toHaveBeenCalledOnce();
  });
});
