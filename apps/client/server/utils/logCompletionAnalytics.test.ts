import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression cover: this credits-estimate lookup used to look up `body.model` directly
 * against the catalog. Once cliCompletions.ts started resolving OpenAI's bare aliases
 * (gpt-4.1, gpt-4.1-mini, gpt-4.1-nano) so the completion itself succeeds, a
 * successful bare-alias request reached this function with a `body.model` this lookup
 * could no longer match, logging a bogus "model not found" error and a zero-credit
 * analytics event for a request that was billed correctly.
 */
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@bike4mind/services', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/services')>()),
  apiKeyService: { getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) },
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  usdToCredits: vi.fn(() => 42),
  getSettingsByNames: vi.fn(),
}));
vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: vi.fn().mockResolvedValue([{ id: 'gpt-4.1-2025-04-14', backend: 'openai' }]),
}));
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  getTextModelCost: vi.fn(() => 1),
}));

import { logEvent } from '@server/utils/analyticsLog';
import { AiEvents } from '@bike4mind/common';
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
    expect((completedCall?.[0] as any)?.metadata.creditsUsed).toBe(42);
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
