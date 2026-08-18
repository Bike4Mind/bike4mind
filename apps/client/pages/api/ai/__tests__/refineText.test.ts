import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { z } from 'zod';
import { ApiKeyScope } from '@bike4mind/common';

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
  refineText: (...a: any[]) => mockRefineText(...a),
  // Real schema so validation + ZodError behave exactly as in production.
  refineTextLLMSchema: z.object({ text: z.string(), context: z.string().optional() }),
  cacheService: { getCachedData: (...a: any[]) => mockGetCachedData(...a) },
}));
vi.mock('@bike4mind/database', () => ({ cacheRepository: { findByKey: vi.fn(), createOrUpdate: vi.fn() } }));

const mockGetOperationsModel = vi.fn();
vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: (...a: any[]) => mockGetOperationsModel(...a) },
}));

import handler from '@pages/api/ai/refineText';

describe('POST /api/ai/refineText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gates the route to the ai:generate scope', () => {
    // Populated at module-eval when baseApi({...}) runs.
    expect(mockBaseApiArgs[0]).toEqual({ requiredScopes: [ApiKeyScope.AI_GENERATE] });
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
    await handler(req as any, res as any);

    expect(mockGetCachedData).toHaveBeenCalledTimes(1);
    const [key, , opts] = mockGetCachedData.mock.calls[0];
    expect(key).toMatch(/^refine-text:/); // hashed, stable per (text, context)
    expect(opts.expiry).toBe(5 * 60 * 1000);
    // maxTokens is finite (not Infinity) - the whole point of the hardening.
    expect(complete.mock.calls[0][2].maxTokens).toBe(800);
    expect(res._getJSONData()).toEqual({ text: 'refined output' });
  });

  it('serves a cached refinement without recomputing', async () => {
    mockGetCachedData.mockResolvedValue('cached refined');

    const { req, res } = createMocks({ method: 'POST', body: { text: 'hello' } });
    await handler(req as any, res as any);

    expect(res._getJSONData()).toEqual({ text: 'cached refined' });
    expect(mockGetOperationsModel).not.toHaveBeenCalled();
    expect(mockRefineText).not.toHaveBeenCalled();
  });
});
