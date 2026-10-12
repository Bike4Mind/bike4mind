import { describe, expect, it } from 'vitest';
import { ChatModels, getTextModelCreditsPer1M, type ModelInfo } from '@bike4mind/common';
import {
  estimateAnswerCount,
  formatAnswersEstimate,
  pickAnswerCostReference,
  typicalAnswerCredits,
  TYPICAL_ANSWER_INPUT_TOKENS,
  TYPICAL_ANSWER_OUTPUT_TOKENS,
} from './creditEstimate';

const model = (id: string, name: string, input: number, output: number): ModelInfo =>
  ({
    id,
    name,
    type: 'text',
    backend: 'bedrock',
    pricing: { 1_000_000: { input: input / 1_000_000, output: output / 1_000_000 } },
  }) as unknown as ModelInfo;

const SONNET_55 = model(ChatModels.CLAUDE_5_5_SONNET_BEDROCK, 'Claude 5.5 Sonnet', 3, 15);
const SONNET_5 = model(ChatModels.CLAUDE_5_SONNET_BEDROCK, 'Claude 5 Sonnet', 3, 15);
const OPUS = model(ChatModels.CLAUDE_5_5_OPUS, 'Claude Opus 5.5', 5, 25);

describe('typicalAnswerCredits', () => {
  it('prices the stated typical answer at the per-1M rates billing publishes', () => {
    const rates = getTextModelCreditsPer1M(SONNET_55)!;
    const expected =
      (TYPICAL_ANSWER_INPUT_TOKENS * rates.input + TYPICAL_ANSWER_OUTPUT_TOKENS * rates.output) / 1_000_000;

    expect(typicalAnswerCredits(SONNET_55)).toBeCloseTo(expected);
  });

  it('returns null for a free-to-run model, so no estimate quotes infinite answers', () => {
    const free = { ...model(ChatModels.CLAUDE_5_5_SONNET_BEDROCK, 'Free', 0, 0), freeToRun: true } as ModelInfo;

    expect(typicalAnswerCredits(free)).toBeNull();
  });

  it('returns null for an unpriced model rather than calling it free', () => {
    expect(typicalAnswerCredits({ ...SONNET_55, pricing: undefined } as unknown as ModelInfo)).toBeNull();
  });
});

describe('pickAnswerCostReference', () => {
  it('quotes the preferred mid-tier model, never the flagship', () => {
    const ref = pickAnswerCostReference([OPUS, SONNET_5, SONNET_55]);

    expect(ref?.modelName).toBe('Claude 5.5 Sonnet');
  });

  it('falls back to the next mid-tier model when the preferred one is missing', () => {
    expect(pickAnswerCostReference([OPUS, SONNET_5])?.modelName).toBe('Claude 5 Sonnet');
  });

  it('falls back to the native Sonnet entry when no Bedrock one is listed', () => {
    const native = model(ChatModels.CLAUDE_5_SONNET, 'Claude 5 Sonnet (native)', 3, 15);

    expect(pickAnswerCostReference([OPUS, native])?.modelName).toBe('Claude 5 Sonnet (native)');
  });

  it('gives no reference when no mid-tier model is priced', () => {
    expect(pickAnswerCostReference([OPUS])).toBeNull();
  });
});

describe('estimateAnswerCount', () => {
  it.each([
    [50_000, 54, 920],
    [10_000, 54, 180],
    [5_000, 54, 92],
    [1_000_000, 54, 18_000],
    // Boundaries of the two-significant-figure rounding: exact below 100, floored from 100 up.
    [99, 1, 99],
    [100, 1, 100],
    [101, 1, 100],
    [999, 1, 990],
    [1_000, 1, 1_000],
  ])('%d credits at %d per answer is about %d answers, rounded down', (credits, perAnswer, expected) => {
    expect(estimateAnswerCount(credits, perAnswer)).toBe(expected);
  });
});

describe('formatAnswersEstimate', () => {
  const ref = { modelName: 'Claude 5.5 Sonnet', creditsPerAnswer: 54 };

  it('labels the figure as an estimate and states the answer size it assumes', () => {
    expect(formatAnswersEstimate(10_000, ref)).toBe(
      'Estimate: about 180 answers on Claude 5.5 Sonnet, at about 4,000 tokens in and 1,000 out per answer. ' +
        'Long chats, files, images and larger models use more.'
    );
  });

  it('says nothing without a priced reference model or credits', () => {
    expect(formatAnswersEstimate(10_000, null)).toBeNull();
    expect(formatAnswersEstimate(0, ref)).toBeNull();
    expect(formatAnswersEstimate(10, ref)).toBeNull();
  });
});
