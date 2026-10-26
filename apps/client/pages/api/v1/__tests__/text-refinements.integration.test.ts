// @vitest-environment node
/**
 * Integration test for POST /api/v1/text-refinements through the real next-connect chain
 * (nextRouteForContract -> apiKeyAuth -> scope check -> validation -> handler) and the real
 * refineTextRequest helper. Only the operations-model resolver and the LLM call are stubbed,
 * so the 503 mapping and the empty-output guard are exercised as they ship.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyScope } from '@bike4mind/common';
import { fire, resetHarness, validateWithScopes } from '@server/generations/__test__/routeHarness';

const { mockGetOperationsModel, mockRefineText, mockFindByKey, mockCreateOrUpdate, cacheStore } = vi.hoisted(() => ({
  mockGetOperationsModel: vi.fn(),
  mockRefineText: vi.fn(),
  mockFindByKey: vi.fn(),
  mockCreateOrUpdate: vi.fn(),
  cacheStore: new Map<string, unknown>(),
}));

vi.mock('@server/utils/apiKeyTrust', () => ({
  applyUntrustedRateLimit: async (_owner: unknown, key: { rateLimit: unknown }) => key.rateLimit,
}));
vi.mock('@client/services/operationsModelService', async orig => ({
  ...(await orig<typeof import('@client/services/operationsModelService')>()),
  OperationsModelService: { getOperationsModel: (...a: unknown[]) => mockGetOperationsModel(...a) },
}));
vi.mock('@bike4mind/services/llm/refineText', async orig => ({
  ...(await orig<typeof import('@bike4mind/services/llm/refineText')>()),
  refineText: (...a: unknown[]) => mockRefineText(...a),
}));
vi.mock('@server/utils/apiKeyRateLimitCheck', async orig =>
  (await import('@server/generations/__test__/routeHarness')).apiKeyRateLimitCheckMock(orig)
);
vi.mock('@server/middlewares/rateLimit', async () =>
  (await import('@server/generations/__test__/routeHarness')).rateLimitMiddlewareMock()
);
vi.mock('@server/utils/userRateTier', async () =>
  (await import('@server/generations/__test__/routeHarness')).userRateTierMock()
);
vi.mock('@server/utils/orgAccess', async orig =>
  (await import('@server/generations/__test__/routeHarness')).orgAccessMock(orig)
);
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@bike4mind/services', async orig =>
  (await import('@server/generations/__test__/routeHarness')).servicesMock(orig)
);
vi.mock('@bike4mind/database', async orig => ({
  ...(await (await import('@server/generations/__test__/routeHarness')).databaseMock(orig)),
  // In-memory cache so the real getCachedData read-through runs.
  cacheRepository: {
    findByKey: (...a: unknown[]) => mockFindByKey(...a),
    createOrUpdate: (...a: unknown[]) => mockCreateOrUpdate(...a),
  },
}));
vi.mock('@server/auth/auth', async orig => (await import('@server/generations/__test__/routeHarness')).authMock(orig));

import handler from '../text-refinements';
import { OperationsModelUnavailableError } from '@client/services/operationsModelService';
import { Logger } from '@bike4mind/observability';
import { CacheKeys } from '@server/utils/cacheKeys';

const post = (body: Record<string, unknown>) => fire({ method: 'POST', url: '/api/v1/text-refinements', body });

describe('POST /api/v1/text-refinements', () => {
  beforeEach(() => {
    resetHarness();
    cacheStore.clear();
    mockGetOperationsModel.mockResolvedValue({ modelId: 'ops-model', llm: { complete: vi.fn() } });
    mockRefineText.mockResolvedValue('A golden retriever on a sunlit beach');
    mockFindByKey.mockImplementation(async (key: string) =>
      cacheStore.has(key) ? { result: cacheStore.get(key) } : null
    );
    mockCreateOrUpdate.mockImplementation(async ({ key, result }: { key: string; result: unknown }) => {
      cacheStore.set(key, result);
    });
  });

  it('returns the refined text for a key with ai:generate', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = post({ text: 'a dog on a beach', context: 'image prompt' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ text: 'A golden retriever on a sunlit beach' });
    expect(mockRefineText).toHaveBeenCalledWith(
      { text: 'a dog on a beach', context: 'image prompt' },
      expect.anything()
    );
  });

  it('serves the second identical request from the cache', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const { req, res } = post({ text: 'a dog on a beach' });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(200);
    }
    expect(mockRefineText).toHaveBeenCalledTimes(1);
  });

  it('403s a key without ai:generate', async () => {
    validateWithScopes([ApiKeyScope.READ_FILES]);
    const { req, res } = post({ text: 'hello' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(mockRefineText).not.toHaveBeenCalled();
  });

  it.each([{}, { text: '' }])('422s an invalid body %j', async body => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = post(body);
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    // The envelope defineNextRoute's ZodError path emits: a readable sentence naming the field.
    expect(res._getJSONData()).toMatchObject({
      name: 'UnprocessableEntityError',
      error: expect.stringContaining('at "text"'),
      request_id: expect.any(String),
    });
    expect(mockRefineText).not.toHaveBeenCalled();
  });

  it.each([
    ['text', { text: 'x'.repeat(10_001) }],
    ['context', { text: 'hello', context: 'x'.repeat(10_001) }],
  ])('422s a %s over the published 10,000-character bound', async (field, body) => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = post(body);
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData()).toMatchObject({
      name: 'UnprocessableEntityError',
      error: expect.stringContaining(`at "${field}"`),
      request_id: expect.any(String),
    });
    expect(mockRefineText).not.toHaveBeenCalled();
  });

  // 10_000 is written literally, not imported: the published bound is what callers rely on, so
  // this test must not move with the constant it pins.
  it.each([
    ['text', { text: 'x'.repeat(10_000) }],
    ['context', { text: 'hello', context: 'x'.repeat(10_000) }],
  ])('200s a %s at exactly the published 10,000-character bound', async (_field, body) => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = post(body);
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockRefineText).toHaveBeenCalledTimes(1);
  });

  it('503s with provider_not_configured when the deployment has no operations text model', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    mockGetOperationsModel.mockRejectedValue(
      new OperationsModelUnavailableError('No text models available for operations')
    );
    const { req, res } = post({ text: 'hello' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(503);
    expect(res._getJSONData()).toMatchObject({
      error: expect.any(String),
      errorCode: 'provider_not_configured',
    });
  });

  it('500s, not 502s or 503s, when the operations-model resolver fails for any other reason', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    // Neither an unconfigured deployment (503) nor the provider's fault (502): an internal error.
    mockGetOperationsModel.mockRejectedValue(new Error('db timeout'));
    const { req, res } = post({ text: 'hello' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(500);
    expect(res._getJSONData()).toMatchObject({ error: 'db timeout', request_id: expect.any(String) });
  });

  it.each([
    ['a cache read', 'MongoNetworkError', () => mockFindByKey.mockRejectedValue(new Error('MongoNetworkError'))],
    ['a cache write', 'MongoWriteError', () => mockCreateOrUpdate.mockRejectedValue(new Error('MongoWriteError'))],
  ])('500s, not 502s, when %s fails', async (_label, message, arrangeFault) => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    // A Mongo fault is ours, not the model's: 502 would tell the caller to blame the provider.
    arrangeFault();
    const { req, res } = post({ text: 'hello' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(500);
    expect(res._getJSONData()).toMatchObject({ error: message, request_id: expect.any(String) });
  });

  it('502s when the model call throws, logging the Error so its stack survives', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const providerError = new Error('boom');
    mockRefineText.mockRejectedValue(providerError);
    const errorLog = vi.spyOn(Logger.prototype, 'error');
    const { req, res } = post({ text: 'hello' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(502);
    expect(res._getJSONData()).toMatchObject({ error: 'Text refinement failed' });
    // The Error object, not its message: the logger keeps `stack || message` from it.
    expect(errorLog).toHaveBeenCalledWith('Text refinement failed', providerError);
    errorLog.mockRestore();
  });

  it.each([401, 403])('401s with provider_rejected when the provider refuses our key (upstream %i)', async status => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    // The provider SDK's own error - a numeric `status` is what the classifier reads. 403 is
    // here too: an access-denied reply to our key is just as permanent as a wrong one.
    mockRefineText.mockRejectedValue(Object.assign(new Error('invalid api key'), { status }));
    const { req, res } = post({ text: 'hello' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(401);
    expect(res._getJSONData()).toMatchObject({
      error: 'The text-refinement provider rejected the configured credential.',
      errorCode: 'provider_rejected',
    });
  });

  it.each([429, 500, 503])(
    '502s, not 401s, when the provider fails with a non-credential status (upstream %i)',
    async status => {
      validateWithScopes([ApiKeyScope.AI_GENERATE]);
      // Only a refused credential is permanent. A rate limit or an outage carries a status too, and
      // answering 401 would tell the caller to stop retrying a transient fault.
      mockRefineText.mockRejectedValue(Object.assign(new Error('provider failed'), { status }));
      const { req, res } = post({ text: 'hello' });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(502);
      expect(res._getJSONData()).toEqual({ error: 'Text refinement failed' });
    }
  );

  it('502s on an empty refinement and does not cache it', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    mockRefineText.mockResolvedValue('');
    for (let attempt = 0; attempt < 2; attempt++) {
      const { req, res } = post({ text: 'hello' });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(502);
      expect(res._getJSONData()).toMatchObject({ error: expect.any(String) });
    }
    // A cached empty result would answer every retry for the whole TTL without calling the model.
    expect(mockRefineText).toHaveBeenCalledTimes(2);
    expect(cacheStore.size).toBe(0);
  });

  it('502s on an empty refinement cached before the helper stopped writing one', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    // The legacy route cached whatever the model returned, so a '' can still be inside the TTL.
    // The guard is a product decision - the response schema is z.string() and would accept '' -
    // so without it this becomes a 200 with no refinement.
    cacheStore.set(CacheKeys.refineText('hello'), '');
    const { req, res } = post({ text: 'hello' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(502);
    expect(res._getJSONData()).toEqual({ error: 'The model returned no refined text' });
    expect(mockRefineText).not.toHaveBeenCalled();
  });
});
