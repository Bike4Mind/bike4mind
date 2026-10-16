import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * The submit route persists a credit hold; the first poll that sees the batch end settles it on
 * the succeeded items' usage. Only the claimCompletion winner may settle, so a retried or
 * concurrent poll never charges twice.
 */

const m = vi.hoisted(() => ({
  getHandler: null as null | ((req: unknown, res: unknown) => unknown),
  batch: null as Record<string, unknown> | null,
  claim: vi.fn(),
  settle: vi.fn(),
  catalog: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    get: (fn: (req: unknown, res: unknown) => unknown) => {
      m.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/utils/config', () => ({ Config: { ANTHROPIC_API_KEY: 'sk-test' } }));
vi.mock('@bike4mind/utils', () => ({
  NotFoundError: class extends Error {},
  usdToCreditsStochastic: (usd: number) => Math.round(usd * 1000),
}));
vi.mock('@server/billing/reserveRequestCredits', () => ({ settleHeldCredits: m.settle }));
vi.mock('@bike4mind/database', () => ({
  transformBatchRepository: { findByAnthropicBatchId: async () => m.batch, claimCompletion: m.claim },
}));
const usage = (input: number, output: number) => ({ inputTokens: input, outputTokens: output });
const batchResults = vi.hoisted(() => ({ items: [] as Record<string, unknown>[] }));
vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: m.catalog,
  AnthropicBatchService: {
    fromApiKey: () => ({
      getBatchResults: async () => ({
        processingStatus: 'ended',
        counts: { processing: 0, succeeded: 2, errored: 1, canceled: 0, expired: 0 },
        results: batchResults.items,
      }),
    }),
  },
}));

await import('@pages/api/transforms/batch/[id]');

const hold = { ownerId: 'u1', reservedCredits: 500 };

async function poll() {
  const { req, res } = createMocks({ method: 'GET', query: { id: 'msgbatch_1' } });
  Object.assign(req, { user: { id: 'u1' }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  await m.getHandler!(req, res);
  return JSON.parse(res._getData());
}

beforeEach(() => {
  vi.clearAllMocks();
  batchResults.items = [
    { customId: 'req_0', clientRef: 'a', status: 'done', reply: 'x', tokenUsage: usage(100, 50) },
    { customId: 'req_1', clientRef: 'b', status: 'done', reply: 'y', tokenUsage: usage(10, 5) },
    { customId: 'req_2', clientRef: 'c', status: 'failed', error: 'overloaded', tokenUsage: usage(999, 999) },
  ];
  m.catalog.mockResolvedValue([{ id: 'm1', pricing: { 200_000: { input: 1e-3, output: 2e-3 } } }]);
  m.batch = {
    id: 'row1',
    ownerUserId: 'u1',
    status: 'in_progress',
    apiKeyId: 'k1',
    usageSource: 'api',
    creditHold: hold,
    customIdMap: ['a', 'b', 'c'].map((ref, i) => ({ customId: `req_${i}`, clientRef: ref, model: 'm1' })),
  };
});

describe('GET /api/transforms/batch/:id settlement', () => {
  it('settles the claimed hold once, on the succeeded items only', async () => {
    m.claim.mockResolvedValue(m.batch);

    await poll();

    // (100 + 10) input at 1e-3 + (50 + 5) output at 2e-3 = $0.22; the failed item is free.
    expect(m.settle).toHaveBeenCalledTimes(1);
    expect(m.settle).toHaveBeenCalledWith(
      hold,
      220,
      {
        type: 'completion_api_usage',
        sessionId: 'msgbatch_1',
        model: 'm1',
        apiKeyId: 'k1',
        source: 'api',
        inputTokens: 110,
        outputTokens: 55,
      },
      expect.objectContaining({ featureLabel: 'batch transforms' })
    );
  });

  it('prices items sharing a client_ref by their own customId model', async () => {
    m.catalog.mockResolvedValue([
      { id: 'm1', pricing: { 200_000: { input: 1e-3, output: 2e-3 } } },
      { id: 'm2', pricing: { 200_000: { input: 4e-3, output: 8e-3 } } },
    ]);
    batchResults.items = [
      { customId: 'req_0', clientRef: 'dup', status: 'done', reply: 'x', tokenUsage: usage(100, 50) },
      { customId: 'req_1', clientRef: 'dup', status: 'done', reply: 'y', tokenUsage: usage(10, 5) },
    ];
    m.batch = {
      ...m.batch,
      customIdMap: [
        { customId: 'req_0', clientRef: 'dup', model: 'm1' },
        { customId: 'req_1', clientRef: 'dup', model: 'm2' },
      ],
    };
    m.claim.mockResolvedValue(m.batch);

    await poll();

    // m1: 100 * 1e-3 + 50 * 2e-3 = $0.2; m2: 10 * 4e-3 + 5 * 8e-3 = $0.08.
    expect(m.settle).toHaveBeenCalledWith(
      hold,
      280,
      expect.objectContaining({ model: 'm1,m2', inputTokens: 110, outputTokens: 55 }),
      expect.anything()
    );
  });

  it('keeps the source stored at submit when a JWT user polls an API-key batch', async () => {
    m.batch = { ...m.batch, usageSource: 'cli' };
    m.claim.mockResolvedValue(m.batch);

    await poll();

    expect(m.settle).toHaveBeenCalledWith(
      hold,
      expect.any(Number),
      expect.objectContaining({ source: 'cli' }),
      expect.anything()
    );
  });

  it('settles nothing when another poll already won the claim, but still returns the results', async () => {
    m.claim.mockResolvedValue(null);

    const body = await poll();

    expect(m.settle).not.toHaveBeenCalled();
    expect(body.results).toHaveLength(3);
  });

  it('settles nothing on a poll served from a completed row', async () => {
    m.batch = { ...m.batch, status: 'completed', results: [] };

    await poll();

    expect(m.claim).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
  });

  it('leaves the batch unclaimed when the catalog cannot load, so a retried poll can still settle', async () => {
    m.catalog.mockRejectedValueOnce(new Error('catalog down'));

    await expect(poll()).rejects.toThrow('catalog down');
    expect(m.claim).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
  });
});
