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

  it.each([
    { lastPrompt: 110_000, expectedCost: 1.1025, expectedTier: 200_000 },
    { lastPrompt: 210_000, expectedCost: 2.6525, expectedTier: 1_000_000 },
  ])(
    'prices each request on its own tier with a $lastPrompt-token cut prompt',
    ({ lastPrompt, expectedCost, expectedTier }) => {
      const tieredModel = {
        ...model,
        pricing: {
          200_000: { input: 5e-6, output: 25e-6 },
          1_000_000: { input: 10e-6, output: 50e-6 },
        },
      };
      const fields = timedOutAttemptUsageFields(tieredModel, {
        inputTokens: 110_000 + lastPrompt,
        outputTokens: 100,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        turnUsage: [
          { inputTokens: 110_000, outputTokens: 100 },
          { inputTokens: lastPrompt, outputTokens: 0 },
        ],
      });

      expect(fields.costUsd).toBeCloseTo(expectedCost, 12);
      expect(fields.rates?.tierKey).toBe(expectedTier);
      expect(fields.turnUsage).toEqual([
        { inputTokens: 110_000, outputTokens: 100, tierKey: 200_000 },
        { inputTokens: lastPrompt, outputTokens: 0, tierKey: expectedTier },
      ]);
    }
  );
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
