import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_EMISSION_PROMPT,
  ChatModels,
  getTextModelCreditsPer1M,
  tokenEstimateMultiplier,
  type ModelInfo,
} from '@bike4mind/common';
import {
  APP_PROMPT_TOKENS,
  estimateAnswerCount,
  formatAnswersEstimate,
  pickAnswerCostReference,
  typicalAnswerCredits,
  TYPICAL_ANSWER_INPUT_TOKENS,
  TYPICAL_ANSWER_OUTPUT_TOKENS,
  TYPICAL_PROMPT_TOKENS,
} from './creditEstimate';

const model = (id: string, name: string, input: number, output: number): ModelInfo =>
  ({
    id,
    name,
    type: 'text',
    backend: 'bedrock',
    pricing: { 1_000_000: { input: input / 1_000_000, output: output / 1_000_000 } },
  }) as unknown as ModelInfo;

const SONNET_55 = model(ChatModels.CLAUDE_5_5_SONNET_BEDROCK, 'Claude Sonnet 5.5', 2, 10);
const SONNET_5 = model(ChatModels.CLAUDE_5_SONNET_BEDROCK, 'Claude 5 Sonnet', 3, 15);
const OPUS = model(ChatModels.CLAUDE_5_5_OPUS, 'Claude Opus 5.5', 5, 25);
const GPT_MINI = model(ChatModels.GPT5_4_MINI, 'GPT-5.4 Mini', 0.75, 4.5);
const HAIKU_55 = model(ChatModels.CLAUDE_5_5_HAIKU_BEDROCK, 'Claude Haiku 5.5', 0.1, 0.5);

describe('typical answer size', () => {
  it("counts the app's own system prompt, not just the user's words", () => {
    // The artifact block alone is thousands of tokens; an estimate that leaves it out undercounts every turn.
    expect(APP_PROMPT_TOKENS).toBeGreaterThan(ARTIFACT_EMISSION_PROMPT.length / 5);
    expect(TYPICAL_ANSWER_INPUT_TOKENS).toBe(APP_PROMPT_TOKENS + TYPICAL_PROMPT_TOKENS);
  });
});

describe('typicalAnswerCredits', () => {
  it("prices the typical answer at the per-1M rates billing publishes, in the model's own token units", () => {
    const rates = getTextModelCreditsPer1M(SONNET_55)!;
    const multiplier = tokenEstimateMultiplier(SONNET_55.id);
    const expected =
      ((TYPICAL_ANSWER_INPUT_TOKENS * rates.input + TYPICAL_ANSWER_OUTPUT_TOKENS * rates.output) * multiplier) /
      1_000_000;

    expect(multiplier).toBeGreaterThan(1);
    expect(typicalAnswerCredits(SONNET_55)).toBeCloseTo(expected);
  });

  it('lands near what a one-line Sonnet 5.5 question is billed, and well above a mini model', () => {
    // A trivial turn bills about 50 credits on Sonnet 5.5 and about 9 on GPT-5.4 Mini.
    expect(typicalAnswerCredits(SONNET_55)).toBeGreaterThan(45);
    expect(typicalAnswerCredits(SONNET_55)).toBeLessThan(70);
    expect(typicalAnswerCredits(GPT_MINI)).toBeGreaterThan(9);
    expect(typicalAnswerCredits(GPT_MINI)).toBeLessThan(typicalAnswerCredits(SONNET_55)! / 2);
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
  it('quotes the preferred mid-tier model as the premium end, never the flagship', () => {
    expect(pickAnswerCostReference([OPUS, SONNET_5, SONNET_55, GPT_MINI])?.premium?.modelName).toBe(
      'Claude Sonnet 5.5'
    );
  });

  it('quotes the preferred small model as the budget end', () => {
    expect(pickAnswerCostReference([HAIKU_55, GPT_MINI, SONNET_55])?.budget?.modelName).toBe('GPT-5.4 Mini');
    expect(pickAnswerCostReference([HAIKU_55, SONNET_55])?.budget?.modelName).toBe('Claude Haiku 5.5');
  });

  it('falls back to the next mid-tier model when the preferred one is missing', () => {
    expect(pickAnswerCostReference([OPUS, SONNET_5])?.premium?.modelName).toBe('Claude 5 Sonnet');
  });

  it('falls back to the native Sonnet entry when no Bedrock one is listed', () => {
    const native = model(ChatModels.CLAUDE_5_SONNET, 'Claude 5 Sonnet (native)', 3, 15);

    expect(pickAnswerCostReference([OPUS, native])?.premium?.modelName).toBe('Claude 5 Sonnet (native)');
  });

  it('skips a disabled model, so the estimate never names one the user cannot pick', () => {
    const disabled = { ...SONNET_55, disabled: true } as ModelInfo;
    const disabledMini = { ...GPT_MINI, disabled: true } as ModelInfo;

    const ref = pickAnswerCostReference([OPUS, disabled, SONNET_5, disabledMini, HAIKU_55]);
    expect(ref?.premium?.modelName).toBe('Claude 5 Sonnet');
    expect(ref?.budget?.modelName).toBe('Claude Haiku 5.5');
  });

  it('keeps whichever end is priced when the other is missing', () => {
    expect(pickAnswerCostReference([OPUS, GPT_MINI])).toEqual({
      premium: null,
      budget: { modelName: 'GPT-5.4 Mini', creditsPerAnswer: typicalAnswerCredits(GPT_MINI) },
    });
  });

  it('gives no reference when neither end is priced', () => {
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
  const premium = { modelName: 'Claude Sonnet 5.5', creditsPerAnswer: 54 };
  const budget = { modelName: 'GPT-5.4 Mini', creditsPerAnswer: 15 };
  const inputTokens = (Math.round(TYPICAL_ANSWER_INPUT_TOKENS / 100) * 100).toLocaleString('en-US');

  it('quotes a range from the premium to the budget model and states the answer size it assumes', () => {
    expect(formatAnswersEstimate(10_000, { premium, budget })).toBe(
      'Estimate: about 180 to 660 answers, depending on the model (Claude Sonnet 5.5 to GPT-5.4 Mini), ' +
        `at about ${inputTokens} tokens in, including the app's instructions, and 1,000 out per answer. ` +
        'Long chats, files, images and larger models use more.'
    );
  });

  it('quotes a single figure when only one end is priced', () => {
    expect(formatAnswersEstimate(10_000, { premium, budget: null })).toMatch(
      /^Estimate: about 180 answers on Claude Sonnet 5\.5, at about/
    );
    expect(formatAnswersEstimate(10_000, { premium: null, budget })).toMatch(
      /^Estimate: about 660 answers on GPT-5\.4 Mini, at about/
    );
  });

  it('quotes a single figure when both ends round to the same count', () => {
    expect(formatAnswersEstimate(10_000, { premium, budget: { ...budget, creditsPerAnswer: 54 } })).toMatch(
      /^Estimate: about 180 answers on Claude Sonnet 5\.5,/
    );
  });

  it('drops an end that buys less than one answer', () => {
    expect(formatAnswersEstimate(20, { premium, budget })).toMatch(/^Estimate: about 1 answer on GPT-5\.4 Mini,/);
  });

  it('says nothing without a priced reference model or credits', () => {
    expect(formatAnswersEstimate(10_000, null)).toBeNull();
    expect(formatAnswersEstimate(0, { premium, budget })).toBeNull();
    expect(formatAnswersEstimate(10, { premium, budget })).toBeNull();
  });
});
