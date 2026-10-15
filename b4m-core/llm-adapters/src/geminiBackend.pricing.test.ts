/**
 * Gemini and xAI cache-read rates. Both adapters forward cached tokens only for a model whose
 * every tier publishes cache_read (publishesCacheReadRate), so each literal here either carries the
 * provider's published rate on every tier or none at all - never the 0.1x default by omission.
 */

import { describe, it, expect } from 'vitest';
import { ChatModels, getTurnsCost, publishesCacheReadRate, type ModelInfo } from '@bike4mind/common';
import { GeminiBackend } from './geminiBackend';
import { XAIBackend } from './xaiBackend';

const textModels = async (): Promise<ModelInfo[]> =>
  [
    ...(await new GeminiBackend('test-key').getModelInfo()),
    ...(await new XAIBackend('test-key').getModelInfo()),
  ].filter(model => model.type === 'text');

const findModel = async (id: ChatModels): Promise<ModelInfo> => {
  const model = (await textModels()).find(m => m.id === id);
  if (!model) throw new Error(`${id} missing from the Gemini/xAI catalogs`);
  return model;
};

// Per 1M tokens: https://ai.google.dev/gemini-api/docs/pricing and https://docs.x.ai/docs/models
const PUBLISHED_CACHE_READ: Partial<Record<ChatModels, Record<number, number>>> = {
  [ChatModels.GEMINI_3_1_PRO_PREVIEW]: { 200000: 0.2, 2097152: 0.4 },
  [ChatModels.GEMINI_3_1_FLASH_LITE]: { 1048576: 0.025 },
  [ChatModels.GEMINI_3_FLASH_PREVIEW]: { 2097152: 0.05 },
  [ChatModels.GEMINI_2_5_PRO]: { 200000: 0.125, 2097152: 0.25 },
  [ChatModels.GEMINI_2_5_FLASH]: { 1048576: 0.03 },
  [ChatModels.GEMINI_2_5_FLASH_LITE]: { 1048576: 0.01 },
  [ChatModels.GROK_4_5]: { 200000: 0.3, 500000: 0.6 },
};

describe('Gemini and xAI cache-read rates', () => {
  it.each(Object.entries(PUBLISHED_CACHE_READ))(
    '%s carries its published cache_read on every tier',
    async (id, rates) => {
      const model = await findModel(id as ChatModels);

      expect(Object.keys(model.pricing).map(Number)).toEqual(Object.keys(rates).map(Number));
      for (const [tier, perMillion] of Object.entries(rates)) {
        expect(model.pricing[Number(tier)].cache_read).toBeCloseTo(perMillion / 1_000_000, 12);
      }
    }
  );

  it('leaves every other model with no cache_read, so its cached tokens stay at the input rate', async () => {
    for (const model of await textModels()) {
      const tiers = Object.values(model.pricing);
      const published = model.id in PUBLISHED_CACHE_READ;
      expect({ id: model.id, published: publishesCacheReadRate(model) }).toEqual({ id: model.id, published });
      if (!published) expect(tiers.some(tier => tier.cache_read !== undefined)).toBe(false);
    }
  });

  it('bills the cached part of a Gemini request at the published cache rate, not 0.1x input', async () => {
    // Its literal input rate is not 10x its published cache rate, so the 0.1x default would differ.
    const model = await findModel(ChatModels.GEMINI_3_FLASH_PREVIEW);
    const [tier] = Object.values(model.pricing);

    // 100K-token prompt, 80K of it served from cache, 2K out.
    const cost = getTurnsCost(model, [{ inputTokens: 20_000, cacheReadInputTokens: 80_000, outputTokens: 2_000 }]);

    expect(cost).toBeCloseTo(20_000 * tier.input + (80_000 * 0.05) / 1_000_000 + 2_000 * tier.output, 10);
  });

  it.each([
    [ChatModels.GEMINI_2_5_PRO, 1.25, 0.125, 10],
    [ChatModels.GEMINI_3_1_PRO_PREVIEW, 2, 0.2, 18],
  ])('bills a cached %s request at or under 200K at the <=200K rates', async (id, input, cacheRead, output) => {
    const model = await findModel(id);

    // 150K-token prompt, 100K of it served from cache, 1K out.
    const cost = getTurnsCost(model, [{ inputTokens: 50_000, cacheReadInputTokens: 100_000, outputTokens: 1_000 }]);

    expect(cost).toBeCloseTo((50_000 * input + 100_000 * cacheRead + 1_000 * output) / 1_000_000, 10);
  });

  it.each([
    [ChatModels.GEMINI_2_5_PRO, 2.5, 0.25, 15],
    [ChatModels.GEMINI_3_1_PRO_PREVIEW, 4, 0.4, 18],
  ])(
    'bills a cached %s request over 200K at the published long-context rates',
    async (id, input, cacheRead, output) => {
      const model = await findModel(id);

      // 250K-token prompt, 200K of it served from cache, 1K out: Google prices every token at the >200K rate.
      const cost = getTurnsCost(model, [{ inputTokens: 50_000, cacheReadInputTokens: 200_000, outputTokens: 1_000 }]);

      expect(cost).toBeCloseTo((50_000 * input + 200_000 * cacheRead + 1_000 * output) / 1_000_000, 10);
    }
  );
});
