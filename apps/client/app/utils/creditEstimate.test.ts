import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_EMISSION_PROMPT,
  ChatModels,
  CONTEXT_WINDOW_SAFETY_BUFFER_TOKENS,
  getTextModelCost,
  getTextModelCreditsPer1M,
  isModelDeprecated,
  reservationOutputTokens,
  tokenEstimateMultiplier,
  type ModelInfo,
  usdToCredits,
} from '@bike4mind/common';
import { buildThinkingParams } from '@bike4mind/llm-adapters/model-sizing';
import {
  APP_PROMPT_TOKENS,
  estimateAnswerCount,
  estimateNextInputTokens,
  formatAnswersEstimate,
  findAffordableModelOffer,
  preflightAnswerCredits,
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
    contextWindow: 1_000_000,
    max_tokens: MAX_TOKENS,
    pricing: { 1_000_000: { input: input / 1_000_000, output: output / 1_000_000 } },
  }) as unknown as ModelInfo;

const MAX_TOKENS = 128_000;

const SONNET_55 = model(ChatModels.CLAUDE_5_5_SONNET_BEDROCK, 'Claude Sonnet 5.5', 2, 10);
const GPT_MINI = model(ChatModels.GPT5_4_MINI, 'GPT-5.4 Mini', 0.75, 4.5);

const HAIKU_55 = model(ChatModels.CLAUDE_5_5_HAIKU_BEDROCK, 'Claude Haiku 5.5', 0.1, 0.5);
const INPUT_TOKENS = 20_000;

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
  it('includes a growing draft and uses a context floor before the first completed turn', () => {
    expect(estimateNextInputTokens(undefined, '')).toBe(TYPICAL_ANSWER_INPUT_TOKENS);
    expect(estimateNextInputTokens(undefined, 'hello')).toBe(TYPICAL_ANSWER_INPUT_TOKENS + 5);
    expect(estimateNextInputTokens(INPUT_TOKENS, 'hello')).toBe(INPUT_TOKENS + 5);
    expect(estimateNextInputTokens(INPUT_TOKENS, 'x'.repeat(40_000))).toBe(INPUT_TOKENS + 40_000);
  });

  it('rescales the last input estimate when switching tokenizer families', () => {
    expect(estimateNextInputTokens(90_000, 'hello', GPT_MINI.id, SONNET_55.id)).toBe(60_005);
    expect(estimateNextInputTokens(60_000, 'hello', SONNET_55.id, GPT_MINI.id)).toBe(90_005);
    expect(estimateNextInputTokens(undefined, '', SONNET_55.id)).toBe(
      Math.ceil(TYPICAL_ANSWER_INPUT_TOKENS * tokenEstimateMultiplier(SONNET_55.id))
    );
  });

  it.each([
    { contextWindow: 8_000, expected: false },
    { contextWindow: 31_000, expected: true },
    { contextWindow: 30_999, expected: false },
    { contextWindow: 0, expected: false },
  ])(
    'only offers candidates whose input, output and buffer fit $contextWindow tokens',
    ({ contextWindow, expected }) => {
      const candidate = { ...HAIKU_55, contextWindow, max_tokens: 10_000 };
      const offer = findAffordableModelOffer([SONNET_55, candidate], SONNET_55.id, 100, INPUT_TOKENS, MAX_TOKENS);
      expect(offer?.affordable.id === candidate.id).toBe(expected);
    }
  );

  it('does not offer a free model whose context is too small', () => {
    const candidate = { ...HAIKU_55, contextWindow: 8_000, max_tokens: 4_000, freeToRun: true };
    expect(findAffordableModelOffer([SONNET_55, candidate], SONNET_55.id, 1, INPUT_TOKENS, MAX_TOKENS)).toBeNull();
  });

  it('reserves the raised thinking ceiling when checking candidate context fit', () => {
    const candidate = {
      ...HAIKU_55,
      id: ChatModels.CLAUDE_4_6_SONNET_BEDROCK,
      can_think: true,
      thinkingStyle: 'legacy',
      contextWindow: 40_000,
      max_tokens: 4_096,
    } as ModelInfo;
    expect(
      findAffordableModelOffer([SONNET_55, candidate], SONNET_55.id, 100, INPUT_TOKENS, MAX_TOKENS)?.affordable.id
    ).toBe(candidate.id);
    expect(
      findAffordableModelOffer([SONNET_55, candidate], SONNET_55.id, 100, INPUT_TOKENS, MAX_TOKENS, {
        enabled: true,
        budget_tokens: 32_000,
      })
    ).toBeNull();
  });

  it('rescales candidate input for both context admission and its credit hold', () => {
    const selected = { ...GPT_MINI, pricing: SONNET_55.pricing };
    const candidate = { ...HAIKU_55, contextWindow: 50_000, max_tokens: 10_000 };
    const offer = findAffordableModelOffer([selected, candidate], selected.id, 100, INPUT_TOKENS, MAX_TOKENS);
    const candidateInput = INPUT_TOKENS * tokenEstimateMultiplier(candidate.id);
    expect(offer?.affordableCredits).toBe(preflightAnswerCredits(candidate, candidateInput, candidate.max_tokens));
    expect(candidateInput + candidate.max_tokens + CONTEXT_WINDOW_SAFETY_BUFFER_TOKENS).toBe(41_000);
    expect(
      findAffordableModelOffer(
        [selected, { ...candidate, contextWindow: 40_999 }],
        selected.id,
        100,
        INPUT_TOKENS,
        MAX_TOKENS
      )
    ).toBeNull();
  });

  it.each([0, -1])('never offers a free-model switch at a blocked balance of %s', credits => {
    const free = { ...GPT_MINI, id: 'free-model', freeToRun: true } as ModelInfo;
    expect(findAffordableModelOffer([SONNET_55, free], SONNET_55.id, credits, INPUT_TOKENS, MAX_TOKENS)).toBeNull();
  });
  it('matches the server hold for the real input and output ceiling', () => {
    expect(preflightAnswerCredits(SONNET_55, INPUT_TOKENS, MAX_TOKENS)).toBe(
      usdToCredits(getTextModelCost(SONNET_55, INPUT_TOKENS, reservationOutputTokens(MAX_TOKENS)))
    );
  });

  it('matches the larger server hold for a model that reasons within its output budget', () => {
    const reasoning = { ...SONNET_55, thinkingStyle: 'adaptive' } as ModelInfo;
    expect(preflightAnswerCredits(reasoning, INPUT_TOKENS, MAX_TOKENS)).toBe(
      usdToCredits(getTextModelCost(reasoning, INPUT_TOKENS, reservationOutputTokens(MAX_TOKENS, true)))
    );
  });

  it('matches the raised server hold when legacy Anthropic thinking is enabled', () => {
    const legacyThinking = {
      ...SONNET_55,
      id: ChatModels.CLAUDE_4_6_SONNET_BEDROCK,
      can_think: true,
      thinkingStyle: 'legacy',
    } as ModelInfo;
    const thinking = { enabled: true, budget_tokens: 32_000 };
    const requestedMaxTokens = 4_096;
    const sentMaxTokens = buildThinkingParams(
      legacyThinking.id,
      legacyThinking,
      thinking.budget_tokens,
      requestedMaxTokens
    ).maxTokens;

    expect(preflightAnswerCredits(legacyThinking, INPUT_TOKENS, requestedMaxTokens, thinking)).toBe(
      usdToCredits(getTextModelCost(legacyThinking, INPUT_TOKENS, reservationOutputTokens(sentMaxTokens, true)))
    );
  });

  it('offers the cheapest model the balance can admit when the selected model cannot', () => {
    const balance = preflightAnswerCredits(GPT_MINI, INPUT_TOKENS, MAX_TOKENS)!;
    const offer = findAffordableModelOffer(
      [SONNET_55, GPT_MINI, HAIKU_55],
      SONNET_55.id,
      balance,
      INPUT_TOKENS,
      MAX_TOKENS
    );

    expect(offer?.affordable.id).toBe(HAIKU_55.id);
    expect(offer?.current.modelName).toBe('Claude Sonnet 5.5');
  });

  it('does not offer a switch when the selected model is affordable or no alternative is', () => {
    expect(
      findAffordableModelOffer(
        [SONNET_55, GPT_MINI],
        SONNET_55.id,
        preflightAnswerCredits(SONNET_55, INPUT_TOKENS, MAX_TOKENS)!,
        INPUT_TOKENS,
        MAX_TOKENS
      )
    ).toBeNull();
    expect(findAffordableModelOffer([SONNET_55], SONNET_55.id, 1, INPUT_TOKENS, MAX_TOKENS)).toBeNull();
  });

  it('never offers a disabled model', () => {
    const disabled = { ...HAIKU_55, disabled: true } as ModelInfo;
    const balance = preflightAnswerCredits(GPT_MINI, INPUT_TOKENS, MAX_TOKENS)!;

    expect(
      findAffordableModelOffer([SONNET_55, GPT_MINI, disabled], SONNET_55.id, balance, INPUT_TOKENS, MAX_TOKENS)
        ?.affordable.id
    ).toBe(GPT_MINI.id);
  });

  it('never offers a deprecated model', () => {
    const deprecated = { ...HAIKU_55, deprecationDate: '2020-01-01' } as ModelInfo;
    const balance = preflightAnswerCredits(GPT_MINI, INPUT_TOKENS, MAX_TOKENS)!;

    expect(isModelDeprecated(deprecated)).toBe(true);
    expect(
      findAffordableModelOffer([SONNET_55, GPT_MINI, deprecated], SONNET_55.id, balance, INPUT_TOKENS, MAX_TOKENS)
        ?.affordable.id
    ).toBe(GPT_MINI.id);
  });

  it('currently offers an accessible free-to-run model first, since it needs 0 credits', () => {
    const free = { ...GPT_MINI, id: 'free-model', name: 'Free', freeToRun: true } as ModelInfo;
    const balance = preflightAnswerCredits(HAIKU_55, INPUT_TOKENS, MAX_TOKENS)!;

    expect(
      findAffordableModelOffer([SONNET_55, HAIKU_55, free], SONNET_55.id, balance, INPUT_TOKENS, MAX_TOKENS)?.affordable
        .id
    ).toBe('free-model');
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
