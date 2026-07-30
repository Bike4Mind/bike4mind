import {
  buildAggregatorKeyIndex,
  measureJoinCoverage,
  resolveAggregatorKey,
  type AggregatorName,
  type ModelIdAliasMap,
} from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import aggregatorKeysFile from './__fixtures__/aggregatorKeys.json';
import aliasFile from './modelIdAliases.json';
import seedFile from './modelCatalog.seed.json';

const aliases = aliasFile.aliases as ModelIdAliasMap;
const seedModelIds = (seedFile.entries as ReadonlyArray<{ modelId: string }>).map(entry => entry.modelId);

const INDEXES: Record<AggregatorName, ReturnType<typeof buildAggregatorKeyIndex>> = {
  modelsDev: buildAggregatorKeyIndex(aggregatorKeysFile.modelsDev, 'modelsDev'),
  litellm: buildAggregatorKeyIndex(aggregatorKeysFile.litellm, 'litellm'),
};

/**
 * Measured against the checked-in seed on 2026-07-28: models.dev 73/120 (60.8%),
 * litellm 105/120 (87.5%). The thresholds sit under those, which tolerates an
 * aggregator retiring a handful of entries while still failing a normalizer
 * regression - dropping any single normalization step costs 10 points or more
 * (the region-prefix strip alone carries 17 Bedrock ids).
 *
 * models.dev is the lower of the two by nature, not by defect: roughly 40% of the
 * seed is retired or legacy (Gemini 1.5, Grok 2/3, Claude 3.x, whisper, sora,
 * transcribe, first-gen Bedrock) and models.dev drops what providers retire,
 * while litellm keeps historical entries.
 *
 * The litellm rate FELL from 89.4% when the SEVEN Moonshot ids landed (five direct
 * plus two Bedrock-served). All seven join models.dev; only four join litellm,
 * because its first-party moonshot list carries k2.5 and k2.6 but not k3 or either
 * k2.7-code. That is the expected shape for a provider newer than the aggregators
 * rather than a normalizer defect: those three are priced from the seed, and the
 * two-agreeing-aggregators rule can only flag them until litellm catches up.
 * Raise these when the seed is next regenerated, never lower them without saying
 * why here.
 */
const MIN_JOIN_RATE: Record<AggregatorName, number> = {
  modelsDev: 0.55,
  litellm: 0.85,
};

describe('modelIdAliases seed', () => {
  it.each(['modelsDev', 'litellm'] as const)('every %s alias names a key the aggregator publishes', aggregator => {
    const dead = Object.entries(aliases)
      .map(([modelId, entry]) => ({ modelId, key: entry[aggregator] }))
      .filter(entry => entry.key !== undefined && !INDEXES[aggregator].byExact.has(entry.key));

    // A dead alias resolves to null forever and never falls back to the
    // normalizer, so it silently unprices its model. That is a build failure.
    expect(dead).toEqual([]);
  });

  it('only aliases ids the catalog actually holds', () => {
    const known = new Set(seedModelIds);
    expect(Object.keys(aliases).filter(modelId => !known.has(modelId))).toEqual([]);
  });

  it('earns its keep: every alias resolves something the normalizer cannot', () => {
    for (const [modelId, entry] of Object.entries(aliases)) {
      for (const aggregator of ['modelsDev', 'litellm'] as const) {
        if (entry[aggregator] === undefined) continue;
        const withAlias = resolveAggregatorKey(modelId, INDEXES[aggregator], aliases);
        expect(withAlias).toEqual({ key: entry[aggregator], how: 'alias' });
        expect(resolveAggregatorKey(modelId, INDEXES[aggregator])?.key).not.toBe(entry[aggregator]);
      }
    }
  });
});

describe('aggregator join coverage over the checked-in seed', () => {
  it.each(['modelsDev', 'litellm'] as const)('%s join rate holds', aggregator => {
    const { matched, total, unmatched } = measureJoinCoverage(seedModelIds, INDEXES[aggregator], aliases);
    const rate = matched / total;

    // The unmatched list is in the message on purpose: a coverage failure is a
    // work item ("these ids lost their price"), not a number to bump.
    expect(
      rate,
      `${aggregator} matched ${matched}/${total}; unmatched: ${unmatched.join(', ')}`
    ).toBeGreaterThanOrEqual(MIN_JOIN_RATE[aggregator]);
  });

  it('litellm outjoins models.dev, which is what makes it the breadth source', () => {
    const modelsDev = measureJoinCoverage(seedModelIds, INDEXES.modelsDev, aliases);
    const litellm = measureJoinCoverage(seedModelIds, INDEXES.litellm, aliases);
    expect(litellm.matched).toBeGreaterThan(modelsDev.matched);
  });

  // The property that matters is injectivity: two DIFFERENT seed ids landing on
  // one aggregator key means one model is quoted the other's price. Calling the
  // same pure function twice with identical arguments cannot show that.
  it.each(['modelsDev', 'litellm'] as const)('resolves no two seed ids to the same %s key', aggregator => {
    const owner = new Map<string, string>();
    for (const modelId of seedModelIds) {
      const hit = resolveAggregatorKey(modelId, INDEXES[aggregator], aliases);
      if (!hit) continue;
      const held = owner.get(hit.key);
      expect(held, `${modelId} and ${held} both resolve to ${aggregator} key ${hit.key}`).toBeUndefined();
      owner.set(hit.key, modelId);
    }
  });
});
