import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression cover: this credits-estimate lookup used to look up `body.model` directly
 * against the catalog. Once cliCompletions.ts started resolving OpenAI's bare aliases
 * (gpt-4.1, gpt-4.1-mini, gpt-4.1-nano) so the completion itself succeeds, a
 * successful bare-alias request reached this function with a `body.model` this lookup
 * could no longer match, logging a bogus "model not found" error and a zero-credit
 * analytics event for a request that was billed correctly.
 */
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@bike4mind/services', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/services')>()),
  apiKeyService: { getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) },
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsByNames: vi.fn(),
}));
vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: vi.fn().mockResolvedValue([{ id: 'gpt-4.1-2025-04-14', backend: 'openai' }]),
}));
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  getTextModelCost: vi.fn(() => 1),
  getTurnsCost: vi.fn(() => 2),
}));

import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';
import { apiKeyService } from '@bike4mind/services';
import { buildApiKeyTable, getAvailableModels } from '@bike4mind/llm-adapters';
import { AiEvents, CREDITS_PER_USD_COST, getTextModelCost, getTurnsCost } from '@bike4mind/common';
import { logCompletionAnalytics } from './logCompletionAnalytics';

const baseParams = {
  type: 'success' as const,
  userId: 'user1',
  apiKeyInfo: undefined,
  source: 'api' as const,
  startTime: Date.now(),
  endpoint: '/api/ai/v1/completions',
  method: 'POST',
  logger: { error: vi.fn() },
  db: { apiKeys: {} as any, adminSettings: {} as any },
  finalInputTokens: 100,
  finalOutputTokens: 50,
  hasToolCalls: false,
};

describe('logCompletionAnalytics - OpenAI bare model alias resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves a bare alias so the credits estimate is not silently zeroed', async () => {
    const logger = { error: vi.fn() };

    await logCompletionAnalytics({
      ...baseParams,
      logger,
      body: { model: 'gpt-4.1', messages: [] } as any,
    });

    expect(logger.error).not.toHaveBeenCalledWith(
      '[COMPLETION_ANALYTICS] Model not found for credits calculation:',
      expect.anything()
    );
    const completedCall = vi
      .mocked(logEvent)
      .mock.calls.find(([event]) => event.type === AiEvents.COMPLETION_API_COMPLETED);
    // getTextModelCost is mocked to $1: the unrounded expectation, not a round-up.
    expect((completedCall?.[0] as any)?.metadata.creditsUsed).toBe(CREDITS_PER_USD_COST);
  });

  it('still logs "model not found" for a genuinely unknown model', async () => {
    const logger = { error: vi.fn() };

    await logCompletionAnalytics({
      ...baseParams,
      logger,
      body: { model: 'not-a-real-model', messages: [] } as any,
    });

    expect(logger.error).toHaveBeenCalledWith('[COMPLETION_ANALYTICS] Model not found for credits calculation:', {
      model: 'not-a-real-model',
    });
  });
});

describe('logCompletionAnalytics - model list lookup', () => {
  it('passes the backend-keyed table executeCompletion uses, so the shared model-list cache entry is reused', async () => {
    const effective = { openai: 'sk-test', imageGen: 'http://image.local' };
    vi.mocked(apiKeyService.getEffectiveLLMApiKeys).mockResolvedValueOnce(effective as never);

    await logCompletionAnalytics({ ...baseParams, body: { model: 'gpt-4.1', messages: [] } as any });

    expect(getAvailableModels).toHaveBeenCalledWith(buildApiKeyTable(effective));
  });
});

describe('logCompletionAnalytics - per-request pricing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prices the per-request usage when the completion reported it, not the summed totals', async () => {
    const finalTurnUsage = [
      { inputTokens: 40, outputTokens: 20, cacheReadInputTokens: 210_000 },
      { inputTokens: 60, outputTokens: 30 },
    ];

    await logCompletionAnalytics({
      ...baseParams,
      finalTurnUsage,
      body: { model: 'gpt-4.1', messages: [] } as any,
    });

    expect(getTurnsCost).toHaveBeenCalledWith(expect.objectContaining({ id: 'gpt-4.1-2025-04-14' }), finalTurnUsage);
    expect(getTextModelCost).not.toHaveBeenCalled();
    const completedCall = vi
      .mocked(logEvent)
      .mock.calls.find(([event]) => event.type === AiEvents.COMPLETION_API_COMPLETED);
    expect((completedCall?.[0] as any)?.metadata.creditsUsed).toBe(2 * CREDITS_PER_USD_COST);
  });

  it('prices the cache tokens in the totals fallback when no per-request usage was reported', async () => {
    await logCompletionAnalytics({
      ...baseParams,
      finalCacheReadTokens: 150_000,
      finalCacheWriteTokens: 2_000,
      body: { model: 'gpt-4.1', messages: [] } as any,
    });

    expect(getTurnsCost).not.toHaveBeenCalled();
    expect(getTextModelCost).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'gpt-4.1-2025-04-14' }),
      baseParams.finalInputTokens,
      baseParams.finalOutputTokens,
      150_000,
      2_000,
      baseParams.finalInputTokens + 150_000 + 2_000
    );
  });
});

describe('logCompletionAnalytics - credits logged', () => {
  const creditsLogged = () =>
    (vi.mocked(logEvent).mock.calls.find(([event]) => event.type === AiEvents.COMPLETION_API_COMPLETED)?.[0] as any)
      ?.metadata.creditsUsed;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs the credits the completion actually settled, whatever the cost prices to', async () => {
    await logCompletionAnalytics({
      ...baseParams,
      finalCreditsUsed: 7,
      body: { model: 'gpt-4.1', messages: [] } as any,
    });

    expect(creditsLogged()).toBe(7);
  });

  it('logs a settled 0 as 0 rather than falling back to the expectation', async () => {
    await logCompletionAnalytics({
      ...baseParams,
      finalCreditsUsed: 0,
      body: { model: 'gpt-4.1', messages: [] } as any,
    });

    expect(creditsLogged()).toBe(0);
  });

  it('logs the settled credits even when the completion reported no output tokens', async () => {
    await logCompletionAnalytics({
      ...baseParams,
      finalOutputTokens: 0,
      finalCreditsUsed: 7,
      body: { model: 'gpt-4.1', messages: [] } as any,
    });

    expect(creditsLogged()).toBe(7);
  });

  it('falls back to the unrounded expectation to two decimals, with no 1-credit minimum', async () => {
    vi.mocked(getTextModelCost).mockReturnValueOnce(0.00001);

    await logCompletionAnalytics({ ...baseParams, body: { model: 'gpt-4.1', messages: [] } as any });

    expect(creditsLogged()).toBe(Math.round(0.00001 * CREDITS_PER_USD_COST * 100) / 100);
    expect(creditsLogged()).toBeLessThan(1);
  });
});
