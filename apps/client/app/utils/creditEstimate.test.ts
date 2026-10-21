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
  modelAnswerCost,
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
const GPT_MINI = model(ChatModels.GPT5_4_MINI, 'GPT-5.4 Mini', 0.75, 4.5);

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

describe('modelAnswerCost', () => {
  it("names the model and carries its own per-answer cost, so the default model's quote matches what it bills", () => {
    expect(modelAnswerCost(SONNET_55)).toEqual({
      modelName: 'Claude Sonnet 5.5',
      creditsPerAnswer: typicalAnswerCredits(SONNET_55),
    });
  });

  it('gives no cost for a free or unpriced model, so nothing quotes infinite answers', () => {
    const free = { ...model(ChatModels.CLAUDE_5_5_SONNET_BEDROCK, 'Free', 0, 0), freeToRun: true } as ModelInfo;

    expect(modelAnswerCost(free)).toBeNull();
    expect(modelAnswerCost({ ...SONNET_55, pricing: undefined } as unknown as ModelInfo)).toBeNull();
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
  const sonnet = { modelName: 'Claude Sonnet 5.5', creditsPerAnswer: 54 };
  const mini = { modelName: 'GPT-5.4 Mini', creditsPerAnswer: 15 };

  it('quotes the answers left on the one model it is given, with no token arithmetic', () => {
    expect(formatAnswersEstimate(10_000, sonnet)).toBe(
      'Estimate: about 180 answers on Claude Sonnet 5.5. Long chats, files, images and larger models use more.'
    );
    expect(formatAnswersEstimate(10_000, sonnet)).not.toMatch(/tokens/);
  });

  it('changes with the selected model', () => {
    expect(formatAnswersEstimate(10_000, mini)).toMatch(/^Estimate: about 660 answers on GPT-5\.4 Mini\./);
    expect(formatAnswersEstimate(10_000, sonnet)).not.toBe(formatAnswersEstimate(10_000, mini));
  });

  it("matches the default model's own per-answer cost", () => {
    const cost = modelAnswerCost(SONNET_55)!;
    const answers = estimateAnswerCount(10_000, cost.creditsPerAnswer);

    expect(formatAnswersEstimate(10_000, cost)).toMatch(
      new RegExp(`^Estimate: about ${answers} answers on Claude Sonnet 5\\.5\\.`)
    );
  });

  it('uses the singular for a single answer', () => {
    expect(formatAnswersEstimate(20, mini)).toMatch(/^Estimate: about 1 answer on GPT-5\.4 Mini\./);
  });

  it('says nothing without a priced model, enough credits for one answer, or any credits', () => {
    expect(formatAnswersEstimate(10_000, null)).toBeNull();
    expect(formatAnswersEstimate(0, sonnet)).toBeNull();
    expect(formatAnswersEstimate(10, sonnet)).toBeNull();
  });
});
