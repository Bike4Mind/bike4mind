import { describe, it, expect, vi, beforeEach } from 'vitest';

const recordOperationalUsageMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../billing', () => ({
  recordOperationalUsage: (...args: unknown[]) => recordOperationalUsageMock(...args),
}));

// Pin the aggregate price so its assertions are deterministic; getTurnsCost stays real so the
// per-request test checks the turns the recorder actually passed.
vi.mock('@bike4mind/common', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/common')>();
  return { ...actual, getTextModelCost: vi.fn<typeof actual.getTextModelCost>(() => 0.0042) };
});

import { getTextModelCost, getTurnsCost, type ModelInfo } from '@bike4mind/common';
import { recordToolOperationalUsage } from './recordToolOperationalUsage';
import type { ToolContext } from './types';

const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn() } as never;

const modelInfo = { id: 'gpt-4o-mini', backend: 'openai' } as never;

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: 'u1',
    user: { id: 'u1' } as never,
    sessionId: 's1',
    logger,
    db: { usageEvents: { record: vi.fn() }, adminSettings: {} as never },
    availableModels: [modelInfo],
    ...overrides,
  } as ToolContext;
}

const completionInfo = { inputTokens: 100, outputTokens: 20 } as never;

beforeEach(() => {
  recordOperationalUsageMock.mockClear();
  (logger.warn as ReturnType<typeof vi.fn>).mockClear();
});

describe('recordToolOperationalUsage', () => {
  it('records an operations UsageEvent with cost + provider resolved from the model catalog', async () => {
    await recordToolOperationalUsage(makeContext(), {
      model: 'gpt-4o-mini',
      completionInfo,
      startTime: Date.now() - 5,
    });

    expect(recordOperationalUsageMock).toHaveBeenCalledTimes(1);
    expect(recordOperationalUsageMock.mock.calls[0][0]).toMatchObject({
      feature: 'operations',
      provider: 'openai',
      model: 'gpt-4o-mini',
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.0042,
      source: 'system',
    });
  });

  it('prices the per-request usage when the backend reported it (each request on its own tier)', async () => {
    // Each request sits under the 200K tier; their sum does not.
    const tiered = {
      id: 'tiered-model',
      backend: 'bedrock',
      pricing: {
        200_000: { input: 0.000003, output: 0.000015 },
        1_000_000: { input: 0.000006, output: 0.0000225 },
      },
    } as unknown as ModelInfo;
    const turnUsage = [
      { inputTokens: 150_000, outputTokens: 500 },
      { inputTokens: 151_000, outputTokens: 700 },
    ];
    await recordToolOperationalUsage(makeContext({ availableModels: [tiered] }), {
      model: 'tiered-model',
      completionInfo: { inputTokens: 301_000, outputTokens: 1_200, turnUsage } as never,
      startTime: Date.now(),
    });

    const recorded = recordOperationalUsageMock.mock.calls[0][0];
    expect(recorded).toMatchObject({ inputTokens: 301_000 });
    expect(recorded.costUsd).toBeCloseTo(301_000 * 0.000003 + 1_200 * 0.000015, 12);
    expect(recorded.costUsd).toBeCloseTo(getTurnsCost(tiered, turnUsage), 12);
  });

  it.each([
    { cacheReadInputTokens: 190_000, cacheCreationInputTokens: 0, expectedCost: 0.174 },
    { cacheReadInputTokens: 0, cacheCreationInputTokens: 190_000, expectedCost: 1.048 },
    { cacheReadInputTokens: 95_000, cacheCreationInputTokens: 95_000, expectedCost: 0.611 },
  ])(
    'tiers aggregate usage on the whole prompt with $cacheReadInputTokens reads and $cacheCreationInputTokens writes',
    async ({ cacheReadInputTokens, cacheCreationInputTokens, expectedCost }) => {
      const actual = await vi.importActual<typeof import('@bike4mind/common')>('@bike4mind/common');
      vi.mocked(getTextModelCost).mockImplementationOnce(actual.getTextModelCost);
      const tieredModel = {
        id: 'tiered-model',
        backend: 'bedrock',
        pricing: {
          200_000: { input: 0.000002, output: 0.000012 },
          1_000_000: { input: 0.000004, output: 0.000018 },
        },
      } as unknown as ModelInfo;
      const onToolLlmUsage = vi.fn();

      await recordToolOperationalUsage(makeContext({ availableModels: [tieredModel], onToolLlmUsage }), {
        model: 'tiered-model',
        completionInfo: {
          inputTokens: 20_000,
          outputTokens: 1_000,
          cacheReadInputTokens,
          cacheCreationInputTokens,
        },
        startTime: Date.now(),
      });

      expect(onToolLlmUsage).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ costUsd: expect.closeTo(expectedCost, 10) })
      );
      expect(recordOperationalUsageMock).toHaveBeenCalledTimes(1);
      expect(recordOperationalUsageMock.mock.calls[0][0].costUsd).toBeCloseTo(expectedCost, 10);
    }
  );

  it('skips recording when the backend reported no token usage', async () => {
    await recordToolOperationalUsage(makeContext(), {
      model: 'gpt-4o-mini',
      completionInfo: { inputTokens: 0, outputTokens: 0 } as never,
      startTime: Date.now(),
    });
    expect(recordOperationalUsageMock).not.toHaveBeenCalled();
  });

  it('records with zero cost and unknown provider (and warns) when the model is not in the catalog', async () => {
    await recordToolOperationalUsage(makeContext({ availableModels: [] }), {
      model: 'mystery-model',
      completionInfo,
      startTime: Date.now(),
    });

    expect(recordOperationalUsageMock.mock.calls[0][0]).toMatchObject({
      provider: 'unknown',
      model: 'mystery-model',
      costUsd: 0,
    });
    // The COGS gap must be visible, not silent (getTextModelCost's own alarm never fires here).
    expect(logger.warn).toHaveBeenCalled();
  });

  it('resolves and attributes to the active organization instead of the selected-org pointer', async () => {
    const findById = vi.fn().mockResolvedValue({ id: 'org1' });
    const context = makeContext({
      user: { id: 'u1', organizationId: 'old-org' } as never,
      organizationId: 'org1',
      db: { usageEvents: { record: vi.fn() }, adminSettings: {} as never, organizations: { findById } } as never,
    });

    await recordToolOperationalUsage(context, { model: 'gpt-4o-mini', completionInfo, startTime: Date.now() });

    expect(findById).toHaveBeenCalledWith('org1');
    expect(recordOperationalUsageMock.mock.calls[0][0]).toMatchObject({ organization: { id: 'org1' } });
  });

  it('keeps a personal turn personal when the user has a selected organization', async () => {
    const findById = vi.fn();
    const context = makeContext({
      user: { id: 'u1', organizationId: 'old-org' } as never,
      db: { usageEvents: { record: vi.fn() }, adminSettings: {}, organizations: { findById } } as never,
    });

    await recordToolOperationalUsage(context, { model: 'gpt-4o-mini', completionInfo, startTime: Date.now() });

    expect(findById).not.toHaveBeenCalled();
    expect(recordOperationalUsageMock.mock.calls[0][0]).toMatchObject({ organization: null });
  });

  it('skips billing when the active organization cannot be resolved', async () => {
    const context = makeContext({
      organizationId: 'missing-org',
      db: { adminSettings: {}, organizations: { findById: vi.fn().mockResolvedValue(null) } } as never,
    });

    await recordToolOperationalUsage(context, { model: 'gpt-4o-mini', completionInfo, startTime: Date.now() });

    expect(recordOperationalUsageMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("attributes the spend to the turn's authenticating API key", async () => {
    await recordToolOperationalUsage(makeContext({ authOrigin: 'apiKey', apiKeyId: 'key-1' }), {
      model: 'gpt-4o-mini',
      completionInfo,
      startTime: Date.now(),
    });

    expect(recordOperationalUsageMock.mock.calls[0][0]).toMatchObject({ apiKeyId: 'key-1' });
  });

  it('passes the host billing repos through so the spend can debit', async () => {
    const operationalBilling = { creditTransactions: {}, users: {}, organizations: {}, activePlans: {} };
    const context = makeContext();
    context.db.operationalBilling = operationalBilling as never;

    await recordToolOperationalUsage(context, { model: 'gpt-4o-mini', completionInfo, startTime: Date.now() });

    expect(recordOperationalUsageMock.mock.calls[0][1].db).toMatchObject(operationalBilling);
  });

  // That host already folds the spend into its own charge; a debit here would bill it twice.
  it('withholds the billing repos when the host folds the spend via onToolLlmUsage', async () => {
    const context = makeContext({ onToolLlmUsage: vi.fn() });
    context.db.operationalBilling = { creditTransactions: {}, users: {}, organizations: {} } as never;

    await recordToolOperationalUsage(context, { model: 'gpt-4o-mini', completionInfo, startTime: Date.now() });

    expect(recordOperationalUsageMock.mock.calls[0][1].db.creditTransactions).toBeUndefined();
  });

  it('never throws when the underlying recorder fails', async () => {
    recordOperationalUsageMock.mockRejectedValueOnce(new Error('sink down'));
    await expect(
      recordToolOperationalUsage(makeContext(), { model: 'gpt-4o-mini', completionInfo, startTime: Date.now() })
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('reports usage to onToolLlmUsage so a billing host can fold in nested spend (#630)', async () => {
    const onToolLlmUsage = vi.fn();
    await recordToolOperationalUsage(makeContext({ onToolLlmUsage }), {
      model: 'gpt-4o-mini',
      completionInfo: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 8,
        cacheCreationInputTokens: 4,
      } as never,
      startTime: Date.now(),
    });

    expect(onToolLlmUsage).toHaveBeenCalledTimes(1);
    expect(onToolLlmUsage).toHaveBeenCalledWith({
      model: 'gpt-4o-mini',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 8,
      cacheWriteTokens: 4,
      costUsd: 0.0042,
    });
  });

  it('does not report usage when the backend reported no tokens', async () => {
    const onToolLlmUsage = vi.fn();
    await recordToolOperationalUsage(makeContext({ onToolLlmUsage }), {
      model: 'gpt-4o-mini',
      completionInfo: { inputTokens: 0, outputTokens: 0 } as never,
      startTime: Date.now(),
    });
    expect(onToolLlmUsage).not.toHaveBeenCalled();
  });

  it('reports usage with costUsd=0 when the model is unpriced', async () => {
    const onToolLlmUsage = vi.fn();
    await recordToolOperationalUsage(makeContext({ availableModels: [], onToolLlmUsage }), {
      model: 'mystery-model',
      completionInfo,
      startTime: Date.now(),
    });
    expect(onToolLlmUsage).toHaveBeenCalledWith(expect.objectContaining({ model: 'mystery-model', costUsd: 0 }));
  });

  it('still reports usage to the billing host when the analytics recorder fails', async () => {
    // Fired before the analytics write, so a sink failure can't drop the charge.
    recordOperationalUsageMock.mockRejectedValueOnce(new Error('sink down'));
    const onToolLlmUsage = vi.fn();
    await recordToolOperationalUsage(makeContext({ onToolLlmUsage }), {
      model: 'gpt-4o-mini',
      completionInfo,
      startTime: Date.now(),
    });
    expect(onToolLlmUsage).toHaveBeenCalledTimes(1);
  });

  it('never throws when the billing-host callback throws (best-effort contract)', async () => {
    // onToolLlmUsage runs inside the best-effort try/catch, so a throwing callback is
    // swallowed rather than breaking the tool it measures - the callback contract in
    // ToolContext requires it not to throw, and this pins the fail-safe behavior. Note
    // the analytics write is skipped on this path, which is why the contract exists.
    const onToolLlmUsage = vi.fn(() => {
      throw new Error('billing host blew up');
    });
    await expect(
      recordToolOperationalUsage(makeContext({ onToolLlmUsage }), {
        model: 'gpt-4o-mini',
        completionInfo,
        startTime: Date.now(),
      })
    ).resolves.toBeUndefined();
    expect(onToolLlmUsage).toHaveBeenCalledTimes(1);
    expect(recordOperationalUsageMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  describe('price stamp', () => {
    const tiered = {
      id: 'tiered-model',
      backend: 'bedrock',
      priceSource: 'catalog',
      priceRowId: 'price-row-5',
      pricing: {
        200_000: { input: 0.000003, output: 0.000015 },
        1_000_000: { input: 0.000006, output: 0.0000225 },
      },
    } as unknown as ModelInfo;

    it('stamps the catalog source, row id and the tier of the whole prompt', async () => {
      await recordToolOperationalUsage(makeContext({ availableModels: [tiered] }), {
        model: 'tiered-model',
        completionInfo: { inputTokens: 20_000, cacheReadInputTokens: 190_000, outputTokens: 100 } as never,
        startTime: Date.now(),
      });

      const { priceStamp } = recordOperationalUsageMock.mock.calls[0][0];
      expect(priceStamp).toMatchObject({ priceSource: 'catalog', priceRowId: 'price-row-5' });
      expect(priceStamp.rates).toMatchObject({ tierKey: 1_000_000, input: 0.000006, output: 0.0000225 });
      expect(priceStamp).not.toHaveProperty('turnUsage');
    });

    it('writes per-request usage only for a multi-request run', async () => {
      const turnUsage = [
        { inputTokens: 150_000, outputTokens: 500 },
        { inputTokens: 151_000, outputTokens: 700 },
      ];
      await recordToolOperationalUsage(makeContext({ availableModels: [tiered] }), {
        model: 'tiered-model',
        completionInfo: { inputTokens: 301_000, outputTokens: 1_200, turnUsage } as never,
        startTime: Date.now(),
      });
      expect(recordOperationalUsageMock.mock.calls[0][0].priceStamp.turnUsage).toHaveLength(2);

      recordOperationalUsageMock.mockClear();
      await recordToolOperationalUsage(makeContext({ availableModels: [tiered] }), {
        model: 'tiered-model',
        completionInfo: { inputTokens: 150_000, outputTokens: 500, turnUsage: turnUsage.slice(0, 1) } as never,
        startTime: Date.now(),
      });
      expect(recordOperationalUsageMock.mock.calls[0][0].priceStamp).not.toHaveProperty('turnUsage');
    });

    it('leaves the stamp unset when the model is not in the request catalog', async () => {
      await recordToolOperationalUsage(makeContext({ availableModels: [] }), {
        model: 'mystery-model',
        completionInfo,
        startTime: Date.now(),
      });
      expect(recordOperationalUsageMock.mock.calls[0][0].priceStamp).toBeUndefined();
    });
  });

  it('records the mapped model and its provider when toLedgerModel is set, cost from the run model', async () => {
    const requested = { id: 'claude-x', backend: 'anthropic' } as never;
    await recordToolOperationalUsage(
      makeContext({
        availableModels: [modelInfo, requested],
        toLedgerModel: id => (id === 'gpt-4o-mini' ? 'claude-x' : id),
      }),
      { model: 'gpt-4o-mini', completionInfo, startTime: Date.now() }
    );
    expect(recordOperationalUsageMock.mock.calls[0][0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-x',
      executedProvider: 'openai',
      executedModel: 'gpt-4o-mini',
      costUsd: 0.0042,
    });
  });

  it('names no executed model when the run model is the recorded one', async () => {
    await recordToolOperationalUsage(makeContext({ toLedgerModel: id => id }), {
      model: 'gpt-4o-mini',
      completionInfo,
      startTime: Date.now(),
    });
    expect(recordOperationalUsageMock.mock.calls[0][0]).not.toHaveProperty('executedModel');
  });

  it('omits the run model provider when the mapped id is not in the catalog', async () => {
    await recordToolOperationalUsage(makeContext(), {
      model: 'gpt-4o-mini',
      ledgerModel: 'gpt-4',
      completionInfo,
      startTime: Date.now(),
    });
    expect(recordOperationalUsageMock.mock.calls[0][0]).toMatchObject({
      provider: 'unknown',
      model: 'gpt-4',
      executedModel: 'gpt-4o-mini',
    });
  });
});
