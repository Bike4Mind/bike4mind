// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  buildModelSelectionPatch,
  computeDefaultMaxTokens,
  getModelCreditRates,
  getModelPriceTier,
  getModelSpeedFromStats,
  getPriceTierTooltip,
  refitMaxTokensForModel,
} from '../aiSettingsUtils';
import { ChatModels, CREDITS_PER_USD_COST, type ModelInfo } from '@bike4mind/common';
import { OpenAIBackend } from '@bike4mind/llm-adapters';

describe('computeDefaultMaxTokens', () => {
  it('falls back to the catalog max_tokens when contextWindow is missing/0', () => {
    // Tier logic needs a context window - without it, defer to the model author's intent.
    expect(computeDefaultMaxTokens({ contextWindow: 0, max_tokens: 16384 })).toBe(16384);
  });

  it('returns 0 when max_tokens is 0', () => {
    expect(computeDefaultMaxTokens({ contextWindow: 128000, max_tokens: 0 })).toBe(0);
  });

  it('halves the context window for small-context models (ctx ≤ 32768)', () => {
    // ctx 8192, max 4096: halve to 4096, capped by model max -> 4096
    expect(computeDefaultMaxTokens({ contextWindow: 8192, max_tokens: 4096 })).toBe(4096);
    // ctx 4096, max 4096: halve to 2048
    expect(computeDefaultMaxTokens({ contextWindow: 4096, max_tokens: 4096 })).toBe(2048);
    expect(computeDefaultMaxTokens({ contextWindow: 16000, max_tokens: 16384 })).toBe(8000);
    expect(computeDefaultMaxTokens({ contextWindow: 32768, max_tokens: 16384 })).toBe(16384);
  });

  it('gives large-context models a quarter of the window, floored at 16384', () => {
    // Just past the small tier: the quarter share (10000) is below the floor -> 16384
    expect(computeDefaultMaxTokens({ contextWindow: 40000, max_tokens: 16384 })).toBe(16384);
    // GPT-5.2 Chat Latest: ctx 128k, max 16k -> the model ceiling binds
    expect(computeDefaultMaxTokens({ contextWindow: 128000, max_tokens: 16384 })).toBe(16384);
    // ctx 200k, max 64k -> quarter share of 50000 binds
    expect(computeDefaultMaxTokens({ contextWindow: 200000, max_tokens: 64000 })).toBe(50000);
  });

  it('gives frontier models their full advertised max_tokens', () => {
    // Claude Opus/Sonnet 5: ctx 1M, max 128k - the quarter share (250k) exceeds the ceiling
    expect(computeDefaultMaxTokens({ contextWindow: 1_000_000, max_tokens: 128000 })).toBe(128000);
    // Grok 4.5: ctx 500k, max 128k -> 125000
    expect(computeDefaultMaxTokens({ contextWindow: 500000, max_tokens: 128000 })).toBe(125000);
    // GPT-5.2: ctx 400k, max 128k -> 100000 (was 16384 before this tier existed)
    expect(computeDefaultMaxTokens({ contextWindow: 400000, max_tokens: 128000 })).toBe(100000);
  });

  it('never lowers the default as the context window grows', () => {
    const windows = [4096, 8192, 16000, 32768, 40000, 128000, 200000, 400000, 1_000_000];
    const defaults = windows.map(contextWindow => computeDefaultMaxTokens({ contextWindow, max_tokens: 128000 }));
    expect(defaults).toEqual([...defaults].sort((a, b) => a - b));
  });

  it('respects model max_tokens when it is lower than the tier cap', () => {
    // ctx 200k, max 4096 -> 4096
    expect(computeDefaultMaxTokens({ contextWindow: 200000, max_tokens: 4096 })).toBe(4096);
  });

  it('does not clamp the window-based target to a derived cap', () => {
    // max_tokens: 4096 here is toModelInfo's substitute for a row that declares none, not a
    // real ceiling - the quarter-window share (100000) must not be pulled back down to it.
    expect(computeDefaultMaxTokens({ contextWindow: 400000, max_tokens: 4096, maxOutputTokensDerived: true })).toBe(
      100000
    );
  });

  it('still honors a declared cap that happens to equal the derived default', () => {
    expect(computeDefaultMaxTokens({ contextWindow: 400000, max_tokens: 4096 })).toBe(4096);
  });

  it('floors fractional results from the halving branch', () => {
    // ctx 4097, max 4097: halve to 2048.5 -> 2048
    expect(computeDefaultMaxTokens({ contextWindow: 4097, max_tokens: 4097 })).toBe(2048);
  });
});

describe('refitMaxTokensForModel', () => {
  const frontier = { contextWindow: 1_000_000, max_tokens: 128000 };
  const small = { contextWindow: 32768, max_tokens: 16384 };

  it('raises a value left low by a weaker model', () => {
    // The regression this fixes: 16384 carried over from a 16k-output model stuck forever.
    expect(refitMaxTokensForModel(16384, frontier)).toBe(128000);
  });

  it('lowers a value carried over from a bigger model', () => {
    expect(refitMaxTokensForModel(128000, small)).toBe(16384);
  });

  it('leaves a value that already sits between the default and the ceiling', () => {
    // User raised it above the default but within what the model advertises - keep it.
    expect(refitMaxTokensForModel(64000, { contextWindow: 200000, max_tokens: 64000 })).toBe(64000);
  });

  it('replaces an unset value with the default', () => {
    expect(refitMaxTokensForModel(0, frontier)).toBe(128000);
    expect(refitMaxTokensForModel(0, frontier, { allowRaise: false })).toBe(128000);
  });

  it('leaves the value alone when the model advertises no ceiling', () => {
    expect(refitMaxTokensForModel(8192, { contextWindow: 128000, max_tokens: 0 })).toBe(8192);
  });

  describe('allowRaise: false (same model - mount, reload, catalog refetch)', () => {
    it('keeps a deliberately-lowered value instead of resetting it to the default', () => {
      expect(refitMaxTokensForModel(2048, frontier, { allowRaise: false })).toBe(2048);
    });

    it('still lowers a value the model cannot accept', () => {
      expect(refitMaxTokensForModel(128000, small, { allowRaise: false })).toBe(16384);
    });
  });

  describe('a derived max_tokens', () => {
    const derivedCatalogOnly = { contextWindow: 400000, max_tokens: 4096, maxOutputTokensDerived: true };

    it('does not reset a value already set above the derived cap', () => {
      // The whole point of the flag: 4096 is toModelInfo's default, not a real ceiling, so a
      // higher persisted value must survive instead of being treated as a stale carry-over.
      expect(refitMaxTokensForModel(64000, derivedCatalogOnly, { allowRaise: false })).toBe(64000);
    });

    it('raises a low value to the window-based target, not the derived cap', () => {
      expect(refitMaxTokensForModel(0, derivedCatalogOnly)).toBe(100000);
    });
  });
});

describe('buildModelSelectionPatch', () => {
  // Only the fields the patch reads; the rest of ModelInfo is irrelevant here.
  const model = (over: Partial<ModelInfo>): ModelInfo =>
    ({ id: 'gpt-4o', type: 'text', contextWindow: 128000, max_tokens: 16384, ...over }) as ModelInfo;

  it('records a text model in the text slot', () => {
    const patch = buildModelSelectionPatch(model({ id: 'gpt-4o', type: 'text' }));
    expect(patch).toMatchObject({ model: 'gpt-4o', lastUsedTextModel: 'gpt-4o' });
    expect(patch).not.toHaveProperty('lastUsedImageModel');
  });

  it('records an image model in the image slot', () => {
    const patch = buildModelSelectionPatch(model({ id: 'gpt-image-1', type: 'image' }));
    expect(patch).toMatchObject({ model: 'gpt-image-1', lastUsedImageModel: 'gpt-image-1' });
    expect(patch).not.toHaveProperty('lastUsedTextModel');
  });

  it.each(['video', 'speech-to-text'] as const)('files a %s model under the text slot, as before', type => {
    // Matches the isImageModel() name-list behavior this replaced: only image models get the
    // image slot, everything else shares the text one.
    const patch = buildModelSelectionPatch(model({ id: 'sora', type }));
    expect(patch).toMatchObject({ lastUsedTextModel: 'sora' });
    expect(patch).not.toHaveProperty('lastUsedImageModel');
  });

  it('resets max_tokens to the new model default', () => {
    expect(buildModelSelectionPatch(model({ contextWindow: 32768, max_tokens: 16384 }))).toMatchObject({
      max_tokens: 16384,
    });
  });
});

describe('getModelSpeedFromStats', () => {
  it('returns null when there are no stats, or none for this model', () => {
    expect(getModelSpeedFromStats('gpt-5', {})).toBeNull();
    expect(getModelSpeedFromStats('gpt-5', undefined as unknown as Record<string, number>)).toBeNull();
    expect(getModelSpeedFromStats('gpt-5', { 'claude-opus-4-5': 1000 })).toBeNull();
  });

  it('buckets the model average against the tooltip thresholds', () => {
    expect(getModelSpeedFromStats('m', { m: 6999 })).toBe('fast');
    expect(getModelSpeedFromStats('m', { m: 7000 })).toBe('medium');
    expect(getModelSpeedFromStats('m', { m: 14999 })).toBe('medium');
    expect(getModelSpeedFromStats('m', { m: 15000 })).toBe('slow');
  });
});

describe('getPriceTierTooltip', () => {
  const textModel = (pricing: ModelInfo['pricing']) => ({ type: 'text', pricing }) as ModelInfo;
  // Literal figures below assume the default rate; this fails first, and clearly, if it moves.
  it('runs at the default 2,000 credits per USD', () => {
    expect(CREDITS_PER_USD_COST).toBe(2000);
  });

  it('matches the pricing table for a cheap model (GPT-4.1 Nano: $0.10 / $0.40 per 1M)', () => {
    const nano = textModel({ 1047576: { input: 0.1 / 1e6, output: 0.4 / 1e6 } });
    expect(getModelCreditRates(nano)).toEqual({ input: '200', output: '800' });
    expect(getPriceTierTooltip('Low', nano)).toBe(
      'Lower cost model: 200 credits per 1M input tokens, 800 per 1M output'
    );
  });

  it('keeps up to 2 decimals so very cheap models are not rounded together', () => {
    const cheap = textModel({ 128000: { input: 0.01234 / 1e6, output: 0.0456 / 1e6 } });
    const cheaper = textModel({ 128000: { input: 0.0123 / 1e6, output: 0.0456 / 1e6 } });

    expect(getModelCreditRates(cheap)).toEqual({ input: '24.68', output: '91.2' });
    expect(getModelCreditRates(cheaper)).toEqual({ input: '24.6', output: '91.2' });
  });

  it('prices a premium model at its base tier with thousands separators', () => {
    const premium = textModel({
      1000000: { input: 6 / 1e6, output: 22.5 / 1e6 },
      200000: { input: 3 / 1e6, output: 15 / 1e6 },
    });

    expect(getModelCreditRates(premium)).toEqual({ input: '6,000', output: '30,000' });
    expect(getPriceTierTooltip('High', premium)).toBe(
      'Premium cost model: 6,000 credits per 1M input tokens, 30,000 per 1M output'
    );
  });

  it('falls back to the tier text when the model has no usable price', () => {
    expect(getPriceTierTooltip('Low', textModel({}))).toBe('Lower cost model');
    expect(getPriceTierTooltip('Low', textModel({ 128000: { input: 0, output: 0 } }))).toBe('Lower cost model');
    expect(getPriceTierTooltip('Medium')).toBe('Medium cost model');
    expect(getPriceTierTooltip('Unknown')).toBe('Cost information unavailable');
  });

  it('shows zero credits for a freeToRun model instead of falling back to the tier text', () => {
    const local = { ...textModel({ 8192: { input: 0, output: 0 } }), freeToRun: true } as ModelInfo;
    expect(getPriceTierTooltip('Low', local)).toBe('Lower cost model: 0 credits per 1M input tokens, 0 per 1M output');
  });

  it('falls back to the tier text when a rate is not a finite number', () => {
    expect(getModelCreditRates(textModel({ 8192: { input: NaN, output: 1 / 1e6 } }))).toBeNull();
    expect(getModelCreditRates(textModel({ 8192: { input: Infinity, output: 1 / 1e6 } }))).toBeNull();
  });

  it('pre-rounds to 4 decimals like getTextModelCreditsPer1M, so the tooltip and table agree', () => {
    // 24.6849998 credits: 4 decimals first gives 24.685, which then shows as 24.69
    const edge = textModel({ 8192: { input: 0.0123424999 / 1e6, output: 1 / 1e6 } });
    expect(getModelCreditRates(edge)).toEqual({ input: '24.69', output: '2,000' });
  });

  it('leaves image models on the tier text, since their pricing is not per token', () => {
    const image = { type: 'image', pricing: { 1: { input: 0.04, output: 0.04 } } } as unknown as ModelInfo;
    expect(getPriceTierTooltip('Medium', image)).toBe('Medium cost model');
  });
});

describe('getModelPriceTier', () => {
  // Real adapter prices, not copies: a price change that moves Terra out of the order its
  // description claims, or across a chip threshold, should fail here and prompt a copy review.
  it('agrees with the GPT-5.6 descriptions on the real catalog prices', async () => {
    const models = await new OpenAIBackend('test-key').getModelInfo();
    const byId = (id: ChatModels) => {
      const model = models.find(m => m.id === id);
      if (!model) throw new Error(`${id} missing from the OpenAI catalog`);
      return model;
    };
    const firstTierAvg = (model: ModelInfo) => {
      const [first] = Object.values(model.pricing ?? {});
      return (first.input + first.output) / 2;
    };
    const sol = byId(ChatModels.GPT5_6_SOL);
    const terra = byId(ChatModels.GPT5_6_TERRA);
    const luna = byId(ChatModels.GPT5_6_LUNA);

    expect(terra.description).toContain('priced between Sol and Luna');
    expect(firstTierAvg(sol)).toBeGreaterThan(firstTierAvg(terra));
    expect(firstTierAvg(terra)).toBeGreaterThan(firstTierAvg(luna));
    expect(getModelPriceTier(sol).tier).toBe('High');
    expect(getModelPriceTier(terra).tier).toBe('High');
    expect(getModelPriceTier(luna).tier).toBe('Medium');
  });
});
