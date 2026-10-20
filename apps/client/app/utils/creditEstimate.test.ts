import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_EMISSION_PROMPT,
  ChatModels,
  getTextModelCreditsPer1M,
  isModelDeprecated,
  tokenEstimateMultiplier,
  type ModelInfo,
} from '@bike4mind/common';
import {
  APP_PROMPT_TOKENS,
  estimateAnswerCount,
  findAffordableModelOffer,
  formatAnswersEstimate,
  modelAnswerCost,
  preflightAnswerCredits,
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

  it('returns null for a free-to-run model even when it still lists prices', () => {
    expect(typicalAnswerCredits({ ...SONNET_55, freeToRun: true } as ModelInfo)).toBeNull();
  });

  it('returns null for an unpriced model rather than calling it free', () => {
    expect(typicalAnswerCredits({ ...SONNET_55, pricing: undefined } as unknown as ModelInfo)).toBeNull();
  });
});

describe('preflight affordability', () => {
  it('uses a larger admission hold than the typical displayed answer', () => {
    expect(preflightAnswerCredits(SONNET_55)!).toBeGreaterThan(typicalAnswerCredits(SONNET_55)!);
  });

  it('offers the cheapest model the balance can admit when the selected model cannot', () => {
    const balance = preflightAnswerCredits(GPT_MINI)!;
    const offer = findAffordableModelOffer([SONNET_55, GPT_MINI, HAIKU_55], SONNET_55.id, balance);

    expect(offer?.affordable.id).toBe(HAIKU_55.id);
    expect(offer?.current.modelName).toBe('Claude Sonnet 5.5');
  });

  it('does not offer a switch when the selected model is affordable or no alternative is', () => {
    expect(
      findAffordableModelOffer([SONNET_55, GPT_MINI], SONNET_55.id, preflightAnswerCredits(SONNET_55)!)
    ).toBeNull();
    expect(findAffordableModelOffer([SONNET_55], SONNET_55.id, 1)).toBeNull();
  });

  it('never offers a disabled model', () => {
    const disabled = { ...HAIKU_55, disabled: true } as ModelInfo;
    const balance = preflightAnswerCredits(GPT_MINI)!;

    expect(findAffordableModelOffer([SONNET_55, GPT_MINI, disabled], SONNET_55.id, balance)?.affordable.id).toBe(
      GPT_MINI.id
    );
  });

  it('never offers a deprecated model', () => {
    const deprecated = { ...HAIKU_55, deprecationDate: '2020-01-01' } as ModelInfo;
    const balance = preflightAnswerCredits(GPT_MINI)!;

    expect(isModelDeprecated(deprecated)).toBe(true);
    expect(findAffordableModelOffer([SONNET_55, GPT_MINI, deprecated], SONNET_55.id, balance)?.affordable.id).toBe(
      GPT_MINI.id
    );
  });

  it('currently offers an accessible free-to-run model first, since it needs 0 credits', () => {
    const free = { ...GPT_MINI, id: 'free-model', name: 'Free', freeToRun: true } as ModelInfo;
    const balance = preflightAnswerCredits(HAIKU_55)!;

    expect(findAffordableModelOffer([SONNET_55, HAIKU_55, free], SONNET_55.id, balance)?.affordable.id).toBe(
      'free-model'
    );
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
