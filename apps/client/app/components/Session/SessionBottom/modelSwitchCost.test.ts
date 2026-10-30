import { describe, expect, it } from 'vitest';
import {
  CACHE_WRITE_MULTIPLIER,
  CREDITS_PER_USD_COST,
  tokenEstimateMultiplier,
  type ModelInfo,
} from '@bike4mind/common';
import {
  getModelSwitchCostNotice,
  MODEL_SWITCH_NOTICE_MIN_CREDITS,
  modelSwitchCacheCredits,
  roundNoticeCredits,
} from './modelSwitchCost';

// USD per 1M tokens; the cache-write rate defaults to input x CACHE_WRITE_MULTIPLIER.
const model = (id: string, input: number, extra: Partial<ModelInfo> = {}): ModelInfo =>
  ({
    id,
    name: id,
    type: 'text',
    backend: 'anthropic',
    contextWindow: 1_000_000,
    max_tokens: 64_000,
    pricing: { 1_000_000: { input: input / 1_000_000, output: (input * 5) / 1_000_000 } },
    ...extra,
  }) as unknown as ModelInfo;

const OPUS = model('claude-opus-5-5', 5);
const SONNET = model('claude-sonnet-5-5', 3);

describe('modelSwitchCacheCredits', () => {
  it('prices the prompt at the new model cache-write rate', () => {
    const expected = (100_000 * 3 * CACHE_WRITE_MULTIPLIER * CREDITS_PER_USD_COST) / 1_000_000;
    expect(modelSwitchCacheCredits(SONNET, 100_000, SONNET.id)).toBeCloseTo(expected, 0);
  });

  it('converts the prompt from the previous model tokens to the new model tokens', () => {
    const gpt = model('gpt-5', 3, { backend: 'openai' } as Partial<ModelInfo>);
    const tokens = (100_000 / tokenEstimateMultiplier(OPUS.id)) * tokenEstimateMultiplier(gpt.id);
    expect(modelSwitchCacheCredits(gpt, 100_000, OPUS.id)).toBeCloseTo(
      (tokens * 3 * CREDITS_PER_USD_COST) / 1_000_000,
      0
    );
  });

  it('prices a backend that bills no cache writes at the input rate', () => {
    const gpt = model('gpt-5', 3, { backend: 'openai' } as Partial<ModelInfo>);
    expect(modelSwitchCacheCredits(gpt, 100_000, gpt.id)).toBeCloseTo(
      (100_000 * 3 * CREDITS_PER_USD_COST) / 1_000_000,
      0
    );
  });

  it('uses a published cache_write rate over the default', () => {
    const published = model('claude-x', 3, {
      pricing: { 1_000_000: { input: 3 / 1_000_000, output: 15 / 1_000_000, cache_write: 6 / 1_000_000 } },
    } as Partial<ModelInfo>);
    expect(modelSwitchCacheCredits(published, 100_000, published.id)).toBeCloseTo(
      (100_000 * 6 * CREDITS_PER_USD_COST) / 1_000_000,
      0
    );
  });

  it('is null for a free or unpriced model', () => {
    expect(modelSwitchCacheCredits({ ...SONNET, freeToRun: true }, 100_000, SONNET.id)).toBeNull();
    expect(
      modelSwitchCacheCredits({ ...SONNET, pricing: undefined } as unknown as ModelInfo, 100_000, SONNET.id)
    ).toBeNull();
  });
});

describe('roundNoticeCredits', () => {
  it('rounds to tens under 1,000 and hundreds above', () => {
    expect(roundNoticeCredits(734.2)).toBe(730);
    expect(roundNoticeCredits(1_249)).toBe(1_200);
    expect(roundNoticeCredits(12_351)).toBe(12_400);
  });
});

describe('getModelSwitchCostNotice', () => {
  const base = { answeredModelId: OPUS.id, previousInputTokens: 150_000, previousInputModelId: OPUS.id };

  it('shows the rounded figure when switching away from the model that answered', () => {
    const credits = getModelSwitchCostNotice({ ...base, selectedModel: SONNET });
    expect(credits).toBe(roundNoticeCredits(modelSwitchCacheCredits(SONNET, 150_000, OPUS.id)!));
    expect(credits).toBeGreaterThanOrEqual(MODEL_SWITCH_NOTICE_MIN_CREDITS);
  });

  it('hides when switching back to the model that answered', () => {
    expect(getModelSwitchCostNotice({ ...base, selectedModel: OPUS })).toBeNull();
  });

  it('hides after a fallback hop when the selected model is the one the user last sent to', () => {
    const fallback = model('claude-haiku-5-5', 1);
    expect(
      getModelSwitchCostNotice({
        ...base,
        selectedModel: OPUS,
        answeredModelId: fallback.id,
        previousInputModelId: OPUS.id,
      })
    ).toBeNull();
  });

  it('hides after a fallback hop when the selected model is the one that answered', () => {
    expect(
      getModelSwitchCostNotice({
        ...base,
        selectedModel: SONNET,
        answeredModelId: SONNET.id,
        previousInputModelId: OPUS.id,
      })
    ).toBeNull();
  });

  it('hides for a new or empty conversation', () => {
    expect(getModelSwitchCostNotice({ ...base, selectedModel: SONNET, answeredModelId: undefined })).toBeNull();
    expect(getModelSwitchCostNotice({ ...base, selectedModel: SONNET, previousInputTokens: undefined })).toBeNull();
    expect(getModelSwitchCostNotice({ ...base, selectedModel: SONNET, previousInputTokens: 0 })).toBeNull();
  });

  it("prices the provider's count of the last prompt over the local estimate", () => {
    const credits = getModelSwitchCostNotice({
      ...base,
      previousInputTokens: 300_000,
      providerInputTokens: 150_000,
      selectedModel: SONNET,
    });
    expect(credits).toBe(roundNoticeCredits(modelSwitchCacheCredits(SONNET, 150_000, OPUS.id)!));
  });

  it('hides below the threshold', () => {
    expect(getModelSwitchCostNotice({ ...base, selectedModel: SONNET, previousInputTokens: 2_000 })).toBeNull();
  });
});
