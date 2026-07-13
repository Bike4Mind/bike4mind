import { describe, it, expect, vi, beforeEach } from 'vitest';

const recordOperationalUsageMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../billing', () => ({
  recordOperationalUsage: (...args: unknown[]) => recordOperationalUsageMock(...args),
}));

// getTextModelCost is pure; pin it so the cost assertion is deterministic.
vi.mock('@bike4mind/common', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/common')>();
  return { ...actual, getTextModelCost: () => 0.0042 };
});

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

  it('resolves and attributes to the organization when the user belongs to one', async () => {
    const findById = vi.fn().mockResolvedValue({ id: 'org1' });
    const context = makeContext({
      user: { id: 'u1', organizationId: 'org1' } as never,
      db: { usageEvents: { record: vi.fn() }, adminSettings: {} as never, organizations: { findById } } as never,
    });

    await recordToolOperationalUsage(context, { model: 'gpt-4o-mini', completionInfo, startTime: Date.now() });

    expect(findById).toHaveBeenCalledWith('org1');
    expect(recordOperationalUsageMock.mock.calls[0][0]).toMatchObject({ organization: { id: 'org1' } });
  });

  it('never throws when the underlying recorder fails', async () => {
    recordOperationalUsageMock.mockRejectedValueOnce(new Error('sink down'));
    await expect(
      recordToolOperationalUsage(makeContext(), { model: 'gpt-4o-mini', completionInfo, startTime: Date.now() })
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});
