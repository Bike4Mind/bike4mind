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
  markSettled: vi.fn(),
  saveResults: vi.fn(),
  getBatchResults: vi.fn(),
  settle: vi.fn(),
  catalog: vi.fn(),
  record: vi.fn(async () => undefined),
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
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { ANTHROPIC_API_KEY: 'sk-test' } }));
vi.mock('@bike4mind/utils', () => ({
  NotFoundError: class extends Error {},
  usdToCreditsStochastic: (usd: number) => Math.round(usd * 1000),
}));
vi.mock('@server/billing/reserveRequestCredits', () => ({ settleHeldCredits: m.settle }));
vi.mock('@bike4mind/database', () => ({
  transformBatchRepository: {
    findByAnthropicBatchId: async () => m.batch,
    claimCompletion: m.claim,
    markCreditSettled: m.markSettled,
    saveResults: m.saveResults,
  },
  usageEventRepository: { record: m.record },
}));
const usage = (input: number, output: number) => ({ inputTokens: input, outputTokens: output });
const batchResults = vi.hoisted(() => ({ items: [] as Record<string, unknown>[] }));
vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: m.catalog,
  AnthropicBatchService: {
    fromApiKey: () => ({
      getBatchResults: m.getBatchResults,
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
  m.getBatchResults.mockImplementation(async () => ({
    processingStatus: 'ended',
    counts: { processing: 0, succeeded: 2, errored: 1, canceled: 0, expired: 0 },
    results: batchResults.items,
  }));
  m.markSettled.mockResolvedValue(true);
  m.saveResults.mockResolvedValue(undefined);
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

    // (100 + 10) input at 1e-3 + (50 + 5) output at 2e-3 = $0.22 standard, $0.11 batch; the failed item is free.
    expect(m.settle).toHaveBeenCalledTimes(1);
    expect(m.settle).toHaveBeenCalledWith(
      hold,
      110,
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
    expect(m.record).toHaveBeenCalledOnce();
    expect(m.record).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'msgbatch_1',
        feature: 'completion_api',
        inputTokens: 110,
        outputTokens: 55,
      })
    );
  });

  it('prices items sharing a client_ref by their own customId model', async () => {
    m.getBatchResults.mockImplementation(async () => ({
      processingStatus: 'ended',
      counts: { processing: 0, succeeded: 2, errored: 1, canceled: 0, expired: 0 },
      results: batchResults.items,
    }));
    m.markSettled.mockResolvedValue(true);
    m.saveResults.mockResolvedValue(undefined);
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
      140,
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

  it('serves stored results on a completed row without contacting Anthropic or settling', async () => {
    m.batch = { ...m.batch, status: 'completed', results: [{ client_ref: 'a', status: 'done', reply: 'x' }] };

    const body = await poll();

    expect(m.getBatchResults).not.toHaveBeenCalled();
    expect(m.claim).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
    expect(body.results).toEqual([{ client_ref: 'a', status: 'done', reply: 'x' }]);
  });

  it('serves a stored zero-result batch without contacting Anthropic', async () => {
    m.batch = { ...m.batch, status: 'completed', results: [] };

    const body = await poll();

    expect(m.getBatchResults).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
    expect(body.results).toEqual([]);
  });

  it('re-streams results for a completed row that has none stored, without settling', async () => {
    m.batch = { ...m.batch, status: 'completed', results: undefined };

    const body = await poll();

    expect(m.getBatchResults).toHaveBeenCalledTimes(1);
    expect(m.claim).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
    expect(m.markSettled).not.toHaveBeenCalled();
    expect(body.results).toHaveLength(3);
    expect(m.saveResults).toHaveBeenCalledWith('row1', expect.any(Array));
  });

  it('claims without results, settles, marks the hold settled, then saves the results', async () => {
    m.claim.mockResolvedValue(m.batch);
    const order: string[] = [];
    m.claim.mockImplementation(async () => (order.push('claim'), m.batch));
    m.settle.mockImplementation(async () => (order.push('settle'), 0));
    m.markSettled.mockImplementation(async () => {
      order.push('markSettled');
      return true;
    });
    m.saveResults.mockImplementation(async () => void order.push('save'));

    await poll();

    expect(order).toEqual(['claim', 'settle', 'markSettled', 'save']);
    expect(m.claim.mock.calls[0][1]).not.toHaveProperty('results');
    expect(m.markSettled).toHaveBeenCalledWith('row1');
  });

  it('keeps the hold on the row when settlement throws', async () => {
    m.claim.mockResolvedValue(m.batch);
    m.settle.mockRejectedValueOnce(new Error('crash'));

    await expect(poll()).rejects.toThrow('crash');
    expect(m.markSettled).not.toHaveBeenCalled();
  });

  it('retries settlement after a prior poll claimed completion and then failed', async () => {
    const durableHold = { ...hold, pendingHoldId: 'pending-1' };
    m.batch = { ...m.batch, creditHold: durableHold };
    m.claim.mockImplementation(async () => {
      const claimed = m.batch;
      m.batch = { ...m.batch, status: 'completed' };
      return claimed;
    });
    m.settle.mockRejectedValueOnce(new Error('settlement unconfirmed')).mockResolvedValueOnce(110);

    await expect(poll()).rejects.toThrow('settlement unconfirmed');
    expect(m.markSettled).not.toHaveBeenCalled();
    const body = await poll();

    expect(m.claim).toHaveBeenCalledTimes(1);
    expect(m.settle).toHaveBeenCalledTimes(2);
    expect(m.settle).toHaveBeenLastCalledWith(
      durableHold,
      110,
      expect.anything(),
      expect.objectContaining({ throwOnUnconfirmed: true })
    );
    expect(m.markSettled).toHaveBeenCalledExactlyOnceWith('row1');
    expect(body.status).toBe('completed');
  });

  it('resumes a durable hold even when another poll already cached the completed results', async () => {
    m.batch = {
      ...m.batch,
      status: 'completed',
      creditHold: { ...hold, pendingHoldId: 'pending-1' },
      results: [{ client_ref: 'a', status: 'done', reply: 'x' }],
    };
    m.settle.mockResolvedValue(110);

    await poll();

    expect(m.claim).not.toHaveBeenCalled();
    expect(m.settle).toHaveBeenCalledTimes(1);
    expect(m.markSettled).toHaveBeenCalledExactlyOnceWith('row1');
  });

  it('recovers after settlement committed but marking the batch settled failed', async () => {
    m.batch = { ...m.batch, status: 'completed', creditHold: { ...hold, pendingHoldId: 'pending-1' } };
    m.settle.mockResolvedValue(110);
    m.markSettled.mockRejectedValueOnce(new Error('write failed')).mockResolvedValueOnce(true);

    await expect(poll()).rejects.toThrow('write failed');
    expect(m.record).not.toHaveBeenCalled();
    await poll();

    expect(m.settle).toHaveBeenCalledTimes(2);
    expect(m.record).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate usage events when another retry already marked the hold settled', async () => {
    m.batch = { ...m.batch, status: 'completed', creditHold: { ...hold, pendingHoldId: 'pending-1' } };
    m.settle.mockResolvedValue(110);
    m.markSettled.mockResolvedValue(false);

    await poll();

    expect(m.settle).toHaveBeenCalledTimes(1);
    expect(m.record).not.toHaveBeenCalled();
  });

  it('still marks the hold settled when the sweep already refunded it', async () => {
    m.claim.mockResolvedValue(m.batch);
    m.settle.mockResolvedValue(0);

    await poll();

    expect(m.markSettled).toHaveBeenCalledWith('row1');
    expect(m.record).toHaveBeenCalledWith(expect.objectContaining({ creditsCharged: 0 }));
  });

  it('still settles and returns the results when the results write fails', async () => {
    m.claim.mockResolvedValue(m.batch);
    m.saveResults.mockRejectedValueOnce(new Error('document too large'));

    const body = await poll();

    expect(m.settle).toHaveBeenCalledTimes(1);
    expect(m.markSettled).toHaveBeenCalledTimes(1);
    expect(body.results).toHaveLength(3);
  });

  it('records the cache read and write tokens on the usage event', async () => {
    batchResults.items = [
      {
        customId: 'req_0',
        clientRef: 'a',
        status: 'done',
        tokenUsage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 300, cacheCreationInputTokens: 40 },
      },
      {
        customId: 'req_1',
        clientRef: 'b',
        status: 'done',
        tokenUsage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 200 },
      },
    ];
    m.claim.mockResolvedValue(m.batch);

    await poll();

    expect(m.record).toHaveBeenCalledWith(expect.objectContaining({ cachedInputTokens: 500, cacheWriteTokens: 40 }));
  });

  it('settles both cache TTLs at their discounted rates on the whole prompt tier', async () => {
    m.getBatchResults.mockImplementation(async () => ({
      processingStatus: 'ended',
      counts: { processing: 0, succeeded: 1, errored: 0, canceled: 0, expired: 0 },
      results: batchResults.items,
    }));
    m.catalog.mockResolvedValue([
      {
        id: 'm1',
        pricing: {
          200_000: { input: 1e-6, output: 5e-6, cache_read: 0.1e-6, cache_write: 1.25e-6 },
          1_000_000: { input: 2e-6, output: 10e-6, cache_read: 0.2e-6, cache_write: 2.5e-6 },
        },
      },
    ]);
    batchResults.items = [
      {
        customId: 'req_0',
        clientRef: 'a',
        status: 'done',
        tokenUsage: {
          inputTokens: 100_000,
          outputTokens: 1_000,
          cacheReadInputTokens: 50_000,
          cacheCreationInputTokens: 60_000,
          cacheWrite5mInputTokens: 20_000,
          cacheWrite1hInputTokens: 40_000,
        },
      },
    ];
    m.claim.mockResolvedValue(m.batch);

    await poll();

    // The whole 210K prompt selects the upper tier: (.2 + .01 + .01 + .05 + .16) / 2.
    expect(m.settle).toHaveBeenCalledWith(hold, 215, expect.anything(), expect.anything());
    expect(m.record).toHaveBeenCalledWith(
      expect.objectContaining({
        costUsd: expect.closeTo(0.215, 12),
        cachedInputTokens: 50_000,
        cacheWriteTokens: 60_000,
      })
    );
  });

  it('leaves the batch unclaimed when the catalog cannot load, so a retried poll can still settle', async () => {
    m.catalog.mockRejectedValueOnce(new Error('catalog down'));

    await expect(poll()).rejects.toThrow('catalog down');
    expect(m.claim).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
  });

  it('settles with submit-time prices even when the model is deprecated and absent from the catalog', async () => {
    const billingModel = { id: 'm1', type: 'text', pricing: { 200_000: { input: 1e-3, output: 2e-3 } } };
    m.batch = {
      ...m.batch,
      billingModels: { m1: billingModel },
      customIdMap: ['a', 'b', 'c'].map((clientRef, index) => ({
        customId: `req_${index}`,
        clientRef,
        model: 'm1',
      })),
    };
    m.catalog.mockResolvedValue([]);
    m.claim.mockResolvedValue(m.batch);

    await poll();

    expect(m.catalog).not.toHaveBeenCalled();
    expect(m.settle).toHaveBeenCalledWith(hold, 110, expect.anything(), expect.anything());
  });

  it('keeps the original rate when catalog prices change after submission', async () => {
    const billingModel = { id: 'm1', type: 'text', pricing: { 200_000: { input: 1e-3, output: 2e-3 } } };
    m.batch = {
      ...m.batch,
      billingModels: { m1: billingModel },
      customIdMap: ['a', 'b', 'c'].map((clientRef, index) => ({
        customId: `req_${index}`,
        clientRef,
        model: 'm1',
      })),
    };
    m.catalog.mockResolvedValue([{ id: 'm1', pricing: { 200_000: { input: 1, output: 2 } } }]);
    m.claim.mockResolvedValue(m.batch);

    await poll();

    expect(m.settle).toHaveBeenCalledWith(hold, 110, expect.anything(), expect.anything());
  });

  it.each([
    { catalog: [] },
    { catalog: [{ id: 'm1', type: 'text', pricing: {} }] },
    { catalog: [{ id: 'm1', type: 'text', pricing: { 200_000: { input: 0, output: 0 } } }] },
  ])('leaves a legacy hold unclaimed when its successful items have no usable price: %j', async ({ catalog }) => {
    m.catalog.mockResolvedValue(catalog);

    await expect(poll()).rejects.toThrow('Cannot price succeeded item');

    expect(m.claim).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
    expect(m.markSettled).not.toHaveBeenCalled();
    expect(m.saveResults).not.toHaveBeenCalled();
  });

  it('keeps a durable completed hold unsettled when its legacy model is missing', async () => {
    m.batch = { ...m.batch, status: 'completed', creditHold: { ...hold, pendingHoldId: 'pending-1' } };
    m.catalog.mockResolvedValue([]);

    await expect(poll()).rejects.toThrow('Cannot price succeeded item');

    expect(m.settle).not.toHaveBeenCalled();
    expect(m.markSettled).not.toHaveBeenCalled();
  });

  it('refuses an unpriced snapshot rather than replacing it with a current price', async () => {
    m.batch = { ...m.batch, billingModels: { m1: { id: 'm1', type: 'text', pricing: {} } } };

    await expect(poll()).rejects.toThrow('Cannot price succeeded item');

    expect(m.catalog).not.toHaveBeenCalled();
    expect(m.claim).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
  });

  it('retains the hold when a succeeded item omits its billable usage', async () => {
    batchResults.items[0] = { customId: 'req_0', clientRef: 'a', status: 'done', reply: 'x' };

    await expect(poll()).rejects.toThrow('Cannot price succeeded item');

    expect(m.claim).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
  });

  it('returns unpriced results without a billing gate when credits were off at submit', async () => {
    m.batch = { ...m.batch, creditHold: null };
    m.catalog.mockResolvedValue([]);
    m.claim.mockResolvedValue(m.batch);

    const body = await poll();

    expect(body.status).toBe('completed');
    expect(body.results).toHaveLength(3);
    expect(m.catalog).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
    expect(m.saveResults).toHaveBeenCalledOnce();
  });

  it.each([0, 1])('keeps the hold when only %i of two succeeded results were returned', async count => {
    batchResults.items = batchResults.items.slice(0, count);

    await expect(poll()).rejects.toThrow('Incomplete succeeded results');

    expect(m.claim).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
    expect(m.markSettled).not.toHaveBeenCalled();
  });
});
