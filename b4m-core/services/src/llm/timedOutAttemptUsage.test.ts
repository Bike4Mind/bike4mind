import { describe, expect, it } from 'vitest';
import { getTextModelCost, ModelBackend, type ModelInfo } from '@bike4mind/common';
import { createAnthropicStreamTimeoutError } from '@bike4mind/llm-adapters';
import { timedOutAttemptUsageFields, timedOutUsageOf } from './timedOutAttemptUsage';

const model = {
  id: 'claude-test',
  type: 'text',
  name: 'Claude Test',
  backend: ModelBackend.Anthropic,
  max_tokens: 100,
  contextWindow: 200_000,
  pricing: { 200_000: { input: 5 / 1_000_000, output: 25 / 1_000_000 } },
  supportsImageVariation: false,
} as unknown as ModelInfo;

describe('timedOutAttemptUsageFields', () => {
  it('books the provider prompt counts as unbilled COGS and leaves the local estimate at 0', () => {
    const fields = timedOutAttemptUsageFields(model, {
      inputTokens: 1000,
      cacheReadInputTokens: 20_000,
      cacheCreationInputTokens: 300,
    });

    expect(fields).toMatchObject({
      provider: ModelBackend.Anthropic,
      model: 'claude-test',
      inputTokens: 0,
      outputTokens: 0,
      providerInputTokens: 1000,
      cachedInputTokens: 20_000,
      cacheWriteTokens: 300,
      settledBasis: 'provider',
      creditsCharged: 0,
      status: 'timeout',
    });
    expect(fields).not.toHaveProperty('providerOutputTokens');
    expect(fields.costUsd).toBeCloseTo(getTextModelCost(model, 1000, 0, 20_000, 300, 21_300), 12);
  });

  it('prices the output of completed tool rounds when the timeout carries it', () => {
    const fields = timedOutAttemptUsageFields(model, {
      inputTokens: 1000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 400,
    });

    expect(fields.providerOutputTokens).toBe(400);
    expect(fields.outputTokens).toBe(0);
    expect(fields.costUsd).toBeCloseTo(getTextModelCost(model, 1000, 400, 0, 0, 1000), 12);
  });
});

describe('timedOutUsageOf', () => {
  it('returns the usage of a timeout and nothing for other errors', () => {
    const usage = { inputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

    expect(timedOutUsageOf(createAnthropicStreamTimeoutError('stream_idle', 90_000, { usage }))).toEqual(usage);
    expect(timedOutUsageOf(createAnthropicStreamTimeoutError('stream_idle', 90_000))).toBeUndefined();
    expect(timedOutUsageOf(Object.assign(new Error('stream timeout'), { usage }))).toBeUndefined();
    expect(timedOutUsageOf('stream timeout')).toBeUndefined();
  });
});
