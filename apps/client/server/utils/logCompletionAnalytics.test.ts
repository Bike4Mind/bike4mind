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
import {
  AiEvents,
  BadRequestError,
  UserApiKeyEvents,
  CREDITS_PER_USD_COST,
  getTextModelCost,
  getTurnsCost,
  spendCapExceededError,
  type IAdminSettingsRepository,
  type IApiKeyRepository,
} from '@bike4mind/common';
import { InsufficientCreditsError } from '@bike4mind/services/llm';
import { logCompletionAnalytics } from './logCompletionAnalytics';

type CompletionBody = Parameters<typeof logCompletionAnalytics>[0]['body'];
const gptBody = { model: 'gpt-4.1', messages: [] } as CompletionBody;
const loggedMetadata = (type: AiEvents) =>
  vi.mocked(logEvent).mock.calls.find(([event]) => event.type === type)?.[0].metadata as Record<string, unknown>;
const completedMetadata = () => loggedMetadata(AiEvents.COMPLETION_API_COMPLETED);

const baseParams = {
  type: 'success' as const,
  userId: 'user1',
  apiKeyInfo: undefined,
  source: 'api' as const,
  startTime: Date.now(),
  endpoint: '/api/ai/v1/completions',
  method: 'POST',
  logger: { error: vi.fn() },
  db: { apiKeys: {} as IApiKeyRepository, adminSettings: {} as IAdminSettingsRepository },
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
      body: gptBody,
    });

    expect(logger.error).not.toHaveBeenCalledWith(
      '[COMPLETION_ANALYTICS] Model not found for credits calculation:',
      expect.anything()
    );
    // getTextModelCost is mocked to $1: the unrounded expectation, not a round-up.
    expect(completedMetadata().creditsUsed).toBe(CREDITS_PER_USD_COST);
  });

  it('still logs "model not found" for a genuinely unknown model', async () => {
    const logger = { error: vi.fn() };

    await logCompletionAnalytics({
      ...baseParams,
      logger,
      body: { model: 'not-a-real-model', messages: [] } as CompletionBody,
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

    await logCompletionAnalytics({ ...baseParams, body: gptBody });

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
      body: gptBody,
    });

    expect(getTurnsCost).toHaveBeenCalledWith(expect.objectContaining({ id: 'gpt-4.1-2025-04-14' }), finalTurnUsage);
    expect(getTextModelCost).not.toHaveBeenCalled();
    expect(completedMetadata().creditsUsed).toBe(2 * CREDITS_PER_USD_COST);
  });

  it('prices the cache tokens in the totals fallback when no per-request usage was reported', async () => {
    await logCompletionAnalytics({
      ...baseParams,
      finalCacheReadTokens: 150_000,
      finalCacheWriteTokens: 2_000,
      body: gptBody,
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
  const creditsLogged = () => completedMetadata().creditsUsed;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs the credits the completion actually settled, whatever the cost prices to', async () => {
    await logCompletionAnalytics({
      ...baseParams,
      finalCreditsUsed: 7,
      body: gptBody,
    });

    expect(creditsLogged()).toBe(7);
  });

  it('logs a settled 0 as 0 rather than falling back to the expectation', async () => {
    await logCompletionAnalytics({
      ...baseParams,
      finalCreditsUsed: 0,
      body: gptBody,
    });

    expect(creditsLogged()).toBe(0);
  });

  it('logs the settled credits even when the completion reported no output tokens', async () => {
    await logCompletionAnalytics({
      ...baseParams,
      finalOutputTokens: 0,
      finalCreditsUsed: 7,
      body: gptBody,
    });

    expect(creditsLogged()).toBe(7);
  });

  it('falls back to the unrounded expectation to two decimals, with no 1-credit minimum', async () => {
    vi.mocked(getTextModelCost).mockReturnValueOnce(0.00001);

    await logCompletionAnalytics({ ...baseParams, body: gptBody });

    expect(creditsLogged()).toBe(Math.round(0.00001 * CREDITS_PER_USD_COST * 100) / 100);
    expect(creditsLogged()).toBeLessThan(1);
  });
});

describe('logCompletionAnalytics - failure event', () => {
  const PROMPT = 'Meeting with Dr. Reyes about my diagnosis at 3pm';
  const failureParams = {
    ...baseParams,
    type: 'failure' as const,
    finalInputTokens: undefined,
    finalOutputTokens: undefined,
    hasToolCalls: undefined,
    body: gptBody,
  };
  const failureMetadata = () => loggedMetadata(AiEvents.COMPLETION_API_FAILED);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores a code and class, never the message', async () => {
    const error = Object.assign(new Error(`400 invalid tool arguments: {"title":"${PROMPT}"}`), { status: 400 });

    await logCompletionAnalytics({ ...failureParams, error });

    expect(failureMetadata()).toMatchObject({ errorCode: 'http_400', status: 400, errorType: 'Error' });
    expect(JSON.stringify(failureMetadata())).not.toContain('Reyes');
  });

  it('keeps the quest error code', async () => {
    const error = new InsufficientCreditsError(`not enough for ${PROMPT}`, 'insufficient_credits');

    await logCompletionAnalytics({ ...failureParams, error });

    expect(failureMetadata()).toMatchObject({
      errorCode: 'insufficient_credits',
      errorType: 'InsufficientCreditsError',
    });
    expect(JSON.stringify(failureMetadata())).not.toContain('Reyes');
  });

  it('keeps the quest error code of a tagged 422', async () => {
    await logCompletionAnalytics({ ...failureParams, error: spendCapExceededError(`cap hit on ${PROMPT}`) });

    expect(failureMetadata()).toMatchObject({ errorCode: 'spend_cap_exceeded', status: 422 });
    expect(JSON.stringify(failureMetadata())).not.toContain('Reyes');
  });

  it("keeps an HTTPError's status and drops an errorCode that is not a short identifier", async () => {
    const error = new BadRequestError('bad', { errorCode: PROMPT });

    await logCompletionAnalytics({ ...failureParams, error });

    expect(failureMetadata()).toMatchObject({ errorCode: 'http_400', status: 400 });
  });

  it('keeps a short identifier errorCode from additionalInfo', async () => {
    const error = new BadRequestError('bad', { errorCode: 'context_length_exceeded' });

    await logCompletionAnalytics({ ...failureParams, error });

    expect(failureMetadata()).toMatchObject({ errorCode: 'context_length_exceeded', status: 400 });
  });

  it('drops an additionalInfo errorCode longer than 64 characters', async () => {
    const error = new BadRequestError('bad', { errorCode: 'a'.repeat(65) });

    await logCompletionAnalytics({ ...failureParams, error });

    expect(failureMetadata().errorCode).toBe('http_400');
  });

  it('omits status and falls back to unknown when the error has neither a code nor a status', async () => {
    await logCompletionAnalytics({ ...failureParams, error: new Error(PROMPT) });

    const metadata = failureMetadata();
    expect(metadata).toMatchObject({ errorCode: 'unknown', errorType: 'Error' });
    expect(metadata).not.toHaveProperty('status');
    expect(JSON.stringify(metadata)).not.toContain('Reyes');
  });

  it('names the model unknown when the request body is missing', async () => {
    await logCompletionAnalytics({
      ...failureParams,
      body: undefined as unknown as CompletionBody,
      error: new Error('x'),
    });

    expect(failureMetadata().modelName).toBe('unknown');
  });

  it('records a null throw as unknown', async () => {
    await logCompletionAnalytics({ ...failureParams, error: null });

    expect(failureMetadata()).toMatchObject({ errorCode: 'unknown', errorType: 'UnknownError' });
  });

  it('drops a class name that is not a short identifier', async () => {
    class LongName extends Error {}
    Object.defineProperty(LongName, 'name', { value: 'x'.repeat(65) });

    await logCompletionAnalytics({ ...failureParams, error: new LongName(PROMPT) });

    expect(failureMetadata().errorType).toBe('UnknownError');
  });

  it('logs a failure to persist the event instead of throwing', async () => {
    const logger = { error: vi.fn() };
    vi.mocked(logEvent).mockRejectedValueOnce(new Error('db down'));

    await logCompletionAnalytics({ ...failureParams, logger, error: new Error('x') });

    expect(logger.error).toHaveBeenCalledWith(
      '[COMPLETION_ANALYTICS] Failed to log failure analytics event:',
      expect.any(Error)
    );
  });

  it('records a non-Error throw as unknown', async () => {
    await logCompletionAnalytics({ ...failureParams, error: PROMPT });

    expect(failureMetadata()).toMatchObject({ errorCode: 'unknown', errorType: 'UnknownError' });
    expect(JSON.stringify(failureMetadata())).not.toContain('Reyes');
  });
});

describe('logCompletionAnalytics - success path edges', () => {
  const body = gptBody;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs the API key usage event when the request used an API key', async () => {
    await logCompletionAnalytics({
      ...baseParams,
      body,
      apiKeyInfo: { keyId: 'key_1234567890abcdefghij', keyName: 'test key' },
    });

    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: UserApiKeyEvents.USED,
        metadata: expect.objectContaining({ keyPrefix: 'key_1234567890ab', statusCode: 200 }),
      })
    );
  });

  it('logs, rather than throws, when persisting the completion or key-usage events fails', async () => {
    const logger = { error: vi.fn() };
    vi.mocked(logEvent).mockRejectedValue(new Error('db down'));

    await logCompletionAnalytics({
      ...baseParams,
      logger,
      body,
      apiKeyInfo: { keyId: 'key_1234567890abcdefghij', keyName: 'test key' },
    });

    expect(logger.error).toHaveBeenCalledWith(
      '[COMPLETION_ANALYTICS] Failed to log completion analytics event:',
      expect.any(Error)
    );
    expect(logger.error).toHaveBeenCalledWith(
      '[COMPLETION_ANALYTICS] Failed to log API key usage event:',
      expect.any(Error)
    );
    vi.mocked(logEvent).mockResolvedValue(undefined);
  });

  it('logs zero credits without an error for a known model that reported no tokens', async () => {
    const logger = { error: vi.fn() };

    await logCompletionAnalytics({ ...baseParams, logger, finalInputTokens: 0, finalOutputTokens: 0, body });

    expect(logger.error).not.toHaveBeenCalled();
    expect(completedMetadata().creditsUsed).toBe(0);
  });

  it('logs zero credits and carries on when the credits lookup throws', async () => {
    const logger = { error: vi.fn() };
    vi.mocked(apiKeyService.getEffectiveLLMApiKeys).mockRejectedValueOnce(new Error('keys down'));

    await logCompletionAnalytics({ ...baseParams, logger, body });

    expect(logger.error).toHaveBeenCalledWith('[COMPLETION_ANALYTICS] Failed to calculate credits:', expect.any(Error));
    expect(completedMetadata().creditsUsed).toBe(0);
  });
});
