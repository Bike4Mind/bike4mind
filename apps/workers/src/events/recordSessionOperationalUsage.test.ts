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

  it('prices the totals when the backend reports no per-request usage', async () => {
    await run({ inputTokens: 1_000, outputTokens: 100, cacheReadInputTokens: 500 });

    expect(recordOperationalUsage.mock.calls[0][0].costUsd).toBeCloseTo(
      getTextModelCost(modelInfo, 1_000, 100, 500, 0),
      12
    );
  });
});
