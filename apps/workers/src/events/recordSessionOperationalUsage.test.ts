import { describe, it, expect, vi, beforeEach } from 'vitest';

const recordOperationalUsage = vi.fn().mockResolvedValue(undefined);
vi.mock('@bike4mind/services', () => ({
  recordOperationalUsage: (...args: unknown[]) => recordOperationalUsage(...args),
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  creditTransactionRepository: {},
  organizationRepository: { findById: vi.fn() },
  usageEventRepository: {},
  userRepository: { findById: vi.fn() },
}));
const activePlanResolver = vi.hoisted(() => ({ hasActivePlan: vi.fn() }));
vi.mock('@server/entitlements/activeSubscriptions', () => ({ activePlanResolver }));

import { getTextModelCost, getTurnsCost, type ModelInfo } from '@bike4mind/common';
import { recordSessionOperationalUsage } from './recordSessionOperationalUsage';

// Long-context tiers: each request below sits under 200K, the summed totals do not.
const modelInfo = {
  id: 'tiered-model',
  backend: 'bedrock',
  pricing: {
    200_000: { input: 0.000003, output: 0.000015 },
    1_000_000: { input: 0.000006, output: 0.0000225 },
  },
} as unknown as ModelInfo;
const logger = { debug: vi.fn(), warn: vi.fn() } as never;
const user = { id: 'u1' } as never;

const run = (completionInfo: object) =>
  recordSessionOperationalUsage({
    user,
    sessionId: 's1',
    modelId: 'tiered-model',
    modelInfo,
    completionInfo: completionInfo as never,
    startTime: Date.now(),
    logger,
  });

describe('recordSessionOperationalUsage', () => {
  beforeEach(() => recordOperationalUsage.mockClear());

  it('prices each request on its own long-context tier when the backend reports per-request usage', async () => {
    const turnUsage = [
      { inputTokens: 150_000, outputTokens: 500 },
      { inputTokens: 151_000, outputTokens: 700 },
    ];

    await run({ inputTokens: 301_000, outputTokens: 1_200, turnUsage });

    const { costUsd } = recordOperationalUsage.mock.calls[0][0];
    expect(costUsd).toBeCloseTo(getTurnsCost(modelInfo, turnUsage), 12);
    expect(costUsd).toBeLessThan(getTextModelCost(modelInfo, 301_000, 1_200));
  });

  it('hands the recorder the billing repos and the plan resolver, so free-tier spend can debit', async () => {
    await run({ inputTokens: 1_000, outputTokens: 100 });

    const { db } = recordOperationalUsage.mock.calls[0][1];
    expect(db).toMatchObject({ activePlans: activePlanResolver });
    expect(db.creditTransactions).toBeDefined();
    expect(db.users).toBeDefined();
    expect(db.organizations).toBeDefined();
  });

  it('prices the totals when the backend reports no per-request usage', async () => {
    await run({ inputTokens: 1_000, outputTokens: 100, cacheReadInputTokens: 500 });

    expect(recordOperationalUsage.mock.calls[0][0].costUsd).toBeCloseTo(
      getTextModelCost(modelInfo, 1_000, 100, 500, 0),
      12
    );
  });

  it('prices a cached long prompt in the totals on the tier its whole prompt falls in', async () => {
    await run({ inputTokens: 20_000, outputTokens: 100, cacheReadInputTokens: 190_000 });

    // 210K prompt: the >200K rates, though the uncached 20K alone sits under the threshold.
    expect(recordOperationalUsage.mock.calls[0][0].costUsd).toBeCloseTo(
      20_000 * 0.000006 + 190_000 * 0.000006 * 0.1 + 100 * 0.0000225,
      12
    );
  });

  describe('price stamp', () => {
    const catalogModel = { ...modelInfo, priceSource: 'catalog', priceRowId: 'price-row-3' } as ModelInfo;
    const runWith = (model: ModelInfo, completionInfo: object) =>
      recordSessionOperationalUsage({
        user,
        sessionId: 's1',
        modelId: 'tiered-model',
        modelInfo: model,
        completionInfo: completionInfo as never,
        startTime: Date.now(),
        logger,
      });

    it('hands the shared recorder a literal stamp on the tier its whole prompt falls in', async () => {
      await runWith(modelInfo, { inputTokens: 20_000, outputTokens: 100, cacheReadInputTokens: 190_000 });

      const { priceStamp } = recordOperationalUsage.mock.calls[0][0];
      expect(priceStamp.priceSource).toBe('literal');
      expect(priceStamp).not.toHaveProperty('priceRowId');
      expect(priceStamp.rates).toMatchObject({ tierKey: 1_000_000, input: 0.000006, output: 0.0000225 });
      expect(priceStamp).not.toHaveProperty('turnUsage');
    });

    it('carries the catalog row id and the per-request breakdown for a multi-turn run', async () => {
      await runWith(catalogModel, {
        inputTokens: 301_000,
        outputTokens: 1_200,
        turnUsage: [
          { inputTokens: 150_000, outputTokens: 500 },
          { inputTokens: 151_000, outputTokens: 700 },
        ],
      });

      const { priceStamp } = recordOperationalUsage.mock.calls[0][0];
      expect(priceStamp).toMatchObject({ priceSource: 'catalog', priceRowId: 'price-row-3' });
      expect(priceStamp.rates).toMatchObject({ tierKey: 200_000 });
      expect(priceStamp.turnUsage).toEqual([
        { inputTokens: 150_000, outputTokens: 500, tierKey: 200_000 },
        { inputTokens: 151_000, outputTokens: 700, tierKey: 200_000 },
      ]);
    });
  });
});
