import { describe, it, expect } from 'vitest';
import type { ModelInfo } from '@bike4mind/common';
import { collectStaticCatalogModels } from './generateModelCatalogSeed';

/**
 * Rank is the picker's primary sort key (sortModelsForPicker in apps/client), and nothing
 * else in the comparator can recover a tier that was authored too high: release date and
 * derived generation only break a tie, so two tiers sharing a rank fall to the alphabet.
 * That is how Gemini 3 Flash Preview came to sit above the Pro of its own generation.
 *
 * Each chain below is one provider group in the order the picker must present it, and the
 * ranks along it have to be STRICTLY increasing - equal ranks are the defect, not a pass.
 * Twin ranks are guarded separately (modelCatalogTwinRank.test.ts); this is about tiers.
 */
const TIER_CHAINS: Record<string, readonly string[]> = {
  gemini: [
    'Gemini 3.5 Flash',
    'Gemini 3 Pro Preview',
    'Gemini 3 Flash Preview',
    'Gemini 3.1 Flash Lite',
    'Gemini 2.5 Flash',
    'Gemini 2.5 Flash Lite',
  ],
  openai: ['GPT-5.6 Sol', 'GPT-5.6 Terra', 'GPT-5.6 Luna'],
};

const rankByName = (models: ModelInfo[]): Map<string, number | undefined> =>
  new Map(models.map(model => [model.name, model.rank]));

describe('static model catalog tier order', () => {
  it.each(Object.entries(TIER_CHAINS))('ranks the %s tiers in the order the picker shows them', async (_, chain) => {
    const ranks = rankByName(await collectStaticCatalogModels());

    // A renamed model silently empties the chain, which would make the assertion vacuous.
    for (const name of chain) expect(ranks.get(name), `${name} is missing from the catalog`).toBeTypeOf('number');

    const actual = chain.map(name => `${name}:${ranks.get(name)}`);
    const ordered = [...chain]
      .sort((a, b) => (ranks.get(a) as number) - (ranks.get(b) as number))
      .map(name => `${name}:${ranks.get(name)}`);
    expect(actual).toEqual(ordered);
    expect(new Set(chain.map(name => ranks.get(name))).size).toBe(chain.length);
  });
});
