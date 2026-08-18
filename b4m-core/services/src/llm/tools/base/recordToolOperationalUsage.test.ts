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
});
