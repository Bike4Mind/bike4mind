import { describe, it, expect } from 'vitest';
import type { ModelInfo } from '@bike4mind/common';
import { collectStaticCatalogModels } from './generateModelCatalogSeed';

/**
 * A model served by two backends is authored twice - once in the provider's own adapter
 * table, once in bedrockBackend/* - and the picker groups both copies under one maker
 * section (getModelBackend in ModelSelection.tsx). Same model, same capability, so a
 * split rank is noise: it sorts one copy above the other for no reason a user can see,
 * and it inflates whichever rank tier the stray copy lands in. Every Bedrock Opus sitting
 * at rank 0 while every direct Opus sat at 1 is what made Anthropic's rank-0 tier
 * meaningless once rank became the picker's primary sort key.
 *
 * Keyed on display NAME, since that is what the picker shows and what makes two rows
 * indistinguishable to a user; the ids necessarily differ. A copy that is deliberately
 * presented as a separate choice carries a distinct name (the Bedrock Kimi rows are
 * suffixed "(Bedrock)") and is therefore not a twin.
 */
const twinGroups = (models: ModelInfo[]): Map<string, ModelInfo[]> => {
  const byName = new Map<string, ModelInfo[]>();
  for (const model of models) {
    byName.set(model.name, [...(byName.get(model.name) ?? []), model]);
  }
  return new Map([...byName].filter(([, group]) => new Set(group.map(m => m.backend)).size > 1));
};

describe('static model catalog twin ranks', () => {
  it('gives the same rank to every backend serving the same model', async () => {
    const groups = twinGroups(await collectStaticCatalogModels());

    const split = [...groups]
      .filter(([, group]) => new Set(group.map(model => model.rank)).size > 1)
      .map(([name, group]) => ({ name, ranks: group.map(model => `${model.backend}:${model.rank}`) }));

    expect(split).toEqual([]);
  });

  it('still finds the twins it is meant to guard (the assertion above is not vacuous)', async () => {
    // A floor, not the exact count: retiring one twin should not fail this, but renaming
    // the whole Bedrock table - which would make the check above pass by finding nothing -
    // should.
    expect(twinGroups(await collectStaticCatalogModels()).size).toBeGreaterThanOrEqual(10);
  });
});
