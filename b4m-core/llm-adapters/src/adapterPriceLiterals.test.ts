import { ChatModels } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { adapterModelIds, adapterPriceTiers, staticPriceBackends } from './adapterPriceLiterals';

describe('adapterPriceTiers', () => {
  it('carries the cache rate a feed never publishes, which is the whole reason it exists', async () => {
    // Without this the price planner writes a DeepSeek tier with no cache_read and
    // getTextModelCost settles cached reads at input * CACHE_READ_MULTIPLIER:
    // 0.03/1M against the published 0.006/1M, a 5x overcharge on every cache hit.
    const tiers = await adapterPriceTiers();

    expect(tiers.get(ChatModels.DEEPSEEK_FLASH)?.cache_read).toBeCloseTo(0.006 / 1_000_000, 12);
  });

  it('covers every backend in the list, not just the one that prompted it', async () => {
    const tiers = await adapterPriceTiers();

    for (const id of [
      ChatModels.GPT5_2,
      ChatModels.CLAUDE_4_5_OPUS,
      ChatModels.GEMINI_3_1_PRO_PREVIEW,
      ChatModels.GROK_4_5,
      ChatModels.KIMI_K3,
      ChatModels.DEEPSEEK_FLASH,
    ]) {
      expect(tiers.get(id), `${id} has no adapter literal`).toBeDefined();
    }
  });

  it('prices no free or non-text model, both of which would carry a meaningless tier', async () => {
    const tiers = await adapterPriceTiers();

    expect(tiers.has(ChatModels.FLUX_PRO)).toBe(false);
    for (const [id, tier] of tiers) {
      expect(tier.input, `${id} priced at zero input`).toBeGreaterThan(0);
      expect(tier.output, `${id} priced at zero output`).toBeGreaterThan(0);
    }
  });

  it('memoizes, the planner asking once per convergence pass', async () => {
    expect(await adapterPriceTiers()).toBe(await adapterPriceTiers());
  });
});

describe('staticPriceBackends', () => {
  it('pins the list, since both a price carry and the checked-in seed are drawn from it', () => {
    // Deliberately a change detector: adding or dropping a backend changes which
    // providers a first discovery row can carry rates for AND what
    // modelPrices.seed.json covers. Both are price decisions, so the list should
    // move as a reviewed diff rather than an edit nobody sees.
    expect(staticPriceBackends().map(backend => backend.constructor.name)).toEqual([
      'OpenAIBackend',
      'AnthropicBackend',
      'UndifferentiatedBedrockBackend',
      'GeminiBackend',
      'XAIBackend',
      'KimiBackend',
      'DeepSeekBackend',
      'AWSBackend',
    ]);
  });

  it('names the one entry that contributes no priced text model', async () => {
    // Every other backend is covered by the seed-freshness test, which fails when
    // its models leave the generated seed. AWSBackend offers only speech-to-text,
    // which both consumers filter out, so nothing else would notice its removal -
    // and if it ever ships a text model, this is where that shows up.
    const backends = staticPriceBackends();
    const pricesText = await Promise.all(
      backends.map(async backend =>
        (await backend.getModelInfo()).some(model => model.type === 'text' && !model.freeToRun)
      )
    );

    expect(backends.filter((_, i) => !pricesText[i]).map(backend => backend.constructor.name)).toEqual(['AWSBackend']);
  });
});

describe('adapterModelIds', () => {
  it('lists the ids of every static adapter table, text or not', async () => {
    const ids = await adapterModelIds();
    const tables = await Promise.all(staticPriceBackends().map(backend => backend.getModelInfo()));

    expect(ids.has(ChatModels.GPT5_2)).toBe(true);
    expect(ids.size).toBe(new Set(tables.flat().map(model => String(model.id))).size);
  });
});
