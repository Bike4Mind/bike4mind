import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { z } from 'zod';

// Capture the options baseApi() is constructed with so we can assert the scope
// gate. Middleware is stripped so the raw handler runs directly (same pattern as
// pages/api/email/__tests__/verify.test.ts). Hoisted because baseApi() runs at
// module-eval, before top-level consts initialize.
const { mockBaseApiArgs } = vi.hoisted(() => ({ mockBaseApiArgs: [] as any[] }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (opts: any) => {
    mockBaseApiArgs.push(opts);
    const chain: any = { use: () => chain, post: (fn: any) => fn, get: (fn: any) => fn };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: any) => fn }));

const mockGetCachedData = vi.fn();
const mockRefineText = vi.fn();
vi.mock('@bike4mind/services', () => ({
  cacheService: { getCachedData: (...a: any[]) => mockGetCachedData(...a) },
  // Metering is covered in server/ai/refineTextRequest.test.ts; here the backend passes through.
  meterCompletionBackend: (llm: unknown) => llm,
}));
vi.mock('@server/billing/meterPlatformCompletion', () => ({ createRequestCompletionMeter: vi.fn() }));
vi.mock('@bike4mind/services/llm/refineText', () => ({
  refineText: (...a: any[]) => mockRefineText(...a),
  // Real schema so validation + ZodError behave exactly as in production.
  refineTextLLMSchema: z.object({ text: z.string(), context: z.string().optional() }),
}));
vi.mock('@bike4mind/database', () => ({ cacheRepository: { findByKey: vi.fn(), createOrUpdate: vi.fn() } }));

const mockGetOperationsModel = vi.fn();
vi.mock('@bike4mind/server-utils/services/operationsModelService', async orig => ({
  // Keep the real exports (the helper's typed unavailable error) and stub only the resolver.
  ...(await orig<typeof import('@bike4mind/server-utils/services/operationsModelService')>()),
  OperationsModelService: { getOperationsModel: (...a: any[]) => mockGetOperationsModel(...a) },
}));

import handler from '@pages/api/ai/refineText';
import errorHandler from '@server/middlewares/errorHandler';
import { CacheKeys } from '@server/utils/cacheKeys';
import { OperationsModelUnavailableError } from '@bike4mind/server-utils/services/operationsModelService';

describe('POST /api/ai/refineText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts a JWT only (API keys use POST /api/v1/text-refinements)', () => {
    // Populated at module-eval when baseApi({...}) runs.
    expect(mockBaseApiArgs[0]).toEqual({ auth: 'jwtOnly' });
  });

  it('rejects an invalid body with a 400 and never calls the LLM/cache', async () => {
    const { req, res } = createMocks({ method: 'POST', body: {} }); // missing `text`

    await expect(handler(req as any, res as any)).rejects.toMatchObject({ statusCode: 400 });
    expect(mockGetCachedData).not.toHaveBeenCalled();
    expect(mockGetOperationsModel).not.toHaveBeenCalled();
  });

  it('refines text on a cache miss via a bounded LLM call', async () => {
    // Cache miss: run the producer.
    mockGetCachedData.mockImplementation(async (_key: string, cb: () => Promise<string>) => cb());
    const complete = vi.fn(async (_modelId, _messages, _opts, cb) => {
      await cb(['refined output']);
    });
    mockGetOperationsModel.mockResolvedValue({ modelId: 'ops-model', llm: { complete } });
    mockRefineText.mockImplementation(async (_params: unknown, adapters: any) => {
      let out: string | undefined;
      await adapters.llm.complete([{ role: 'user', content: 'x' }], async (v: string) => {
        out = v;
      });
      return out;
    });

    const { req, res } = createMocks({ method: 'POST', body: { text: 'hello', context: 'ctx' } });

    Object.assign(req, { user: { id: 'u1' } });
    await handler(req as any, res as any);

    expect(mockGetCachedData).toHaveBeenCalledTimes(1);
    const [key, , opts] = mockGetCachedData.mock.calls[0];
    // Exact key: both routes share this helper, so a dropped `context` would serve one
    // context's refinement for another on both of them.
    expect(key).toBe(CacheKeys.refineText('hello', 'ctx'));
    expect(mockRefineText).toHaveBeenCalledWith({ text: 'hello', context: 'ctx' }, expect.anything());
    expect(opts.expiry).toBe(5 * 60 * 1000);
    // maxTokens is finite (not Infinity) - the whole point of the hardening.
    expect(complete.mock.calls[0][2].maxTokens).toBe(800);
    // The helper is the one adapter call both routes share: a dropped model id fails every
    // refine at the provider, and streaming lets refineText's per-chunk callback cache a
    // partial refinement.
    expect(complete.mock.calls[0][0]).toBe('ops-model');
    expect(complete.mock.calls[0][2]).toMatchObject({ stream: false, maxTokens: 800 });
    expect(res._getJSONData()).toEqual({ text: 'refined output' });
  });

  it('answers 500 (not 503) when the deployment has no operations text model', async () => {
    mockGetCachedData.mockImplementation(async (_key: string, cb: () => Promise<string>) => cb());
    mockGetOperationsModel.mockRejectedValue(
      new OperationsModelUnavailableError('No text models available for operations')
    );

    const { req, res } = createMocks({ method: 'POST', body: { text: 'hello' } });

    Object.assign(req, { user: { id: 'u1' } });
    // The route unwraps the helper's error back to the service's own, which has no statusCode,
    // so errorHandler's default 500 carries the real reason. The v1 route is the one that maps it to 503.
    const error = await handler(req as any, res as any).catch((e: unknown) => e);
    expect(error).toMatchObject({
      name: 'OperationsModelUnavailableError',
      message: 'No text models available for operations',
    });
    expect((error as { statusCode?: number }).statusCode).toBeUndefined();
    expect(mockRefineText).not.toHaveBeenCalled();
  });

  it('serves a cached refinement without recomputing', async () => {
    mockGetCachedData.mockResolvedValue('cached refined');

    const { req, res } = createMocks({ method: 'POST', body: { text: 'hello' } });

    Object.assign(req, { user: { id: 'u1' } });
    await handler(req as any, res as any);

    expect(res._getJSONData()).toEqual({ text: 'cached refined' });
    expect(mockGetOperationsModel).not.toHaveBeenCalled();
    expect(mockRefineText).not.toHaveBeenCalled();
  });

  it('passes a provider failure through so errorHandler keeps its 429 and warn level', async () => {
    mockGetCachedData.mockImplementation(async (_key: string, cb: () => Promise<string>) => cb());
    mockGetOperationsModel.mockResolvedValue({ modelId: 'ops-model', llm: { complete: vi.fn() } });
    // An OpenAI/Anthropic SDK APIError: a numeric `status` on the error.
    const providerError = Object.assign(new Error('rate limited'), { status: 429 });
    mockRefineText.mockRejectedValue(providerError);

    const { req, res } = createMocks({ method: 'POST', body: { text: 'hello' } });

    Object.assign(req, { user: { id: 'u1' } });
    const logger = { error: vi.fn(), warn: vi.fn() };
    Object.assign(req, { logger, requestId: 'trace-legacy-1' });

    const thrown = await handler(req as any, res as any).catch((e: unknown) => e);
    // The provider's own error, not RefineFailedError: the wrapper carries no `status`, so
    // errorHandler would answer 500 at `error` - the alarm path - instead of 429 at `warn`.
    expect(thrown).toBe(providerError);

    errorHandler(thrown, req as any, res as any);
    expect(res._getStatusCode()).toBe(429);
    expect(res._getJSONData()).toMatchObject({ error: 'rate limited', request_id: 'trace-legacy-1' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('429'));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('answers 500 for an empty refinement, where main answered 200 {}', async () => {
    mockGetCachedData.mockImplementation(async (_key: string, cb: () => Promise<string>) => cb());
    mockGetOperationsModel.mockResolvedValue({ modelId: 'ops-model', llm: { complete: vi.fn() } });
    mockRefineText.mockResolvedValue('');

    const { req, res } = createMocks({ method: 'POST', body: { text: 'hello' } });

    Object.assign(req, { user: { id: 'u1' } });
    Object.assign(req, { logger: { error: vi.fn(), warn: vi.fn() }, requestId: 'trace-legacy-2' });

    const thrown = await handler(req as any, res as any).catch((e: unknown) => e);
    // No cause to unwrap - an empty output is not a provider error - so the wrapper stands and
    // errorHandler's default 500 applies. main answered 200 {} here (it cached and sent the
    // undefined output); treating an empty refinement as a failure is a deliberate, accepted
    // change on this route, not a preserved behaviour.
    expect(thrown).toMatchObject({ name: 'RefineFailedError' });
    expect((thrown as { cause?: unknown }).cause).toBeUndefined();

    errorHandler(thrown, req as any, res as any);
    expect(res._getStatusCode()).toBe(500);
  });
});
