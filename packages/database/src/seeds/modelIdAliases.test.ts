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
 * Measured against the checked-in seed on 2026-07-26: models.dev 66/113 (58.4%),
 * litellm 101/113 (89.4%). The thresholds sit ~3 points under, which tolerates an
 * aggregator retiring a handful of entries while still failing a normalizer
 * regression - dropping any single normalization step costs 10 points or more
 * (the region-prefix strip alone carries 17 Bedrock ids).
 *
 * models.dev is the lower of the two by nature, not by defect: roughly 40% of the
 * seed is retired or legacy (Gemini 1.5, Grok 2/3, Claude 3.x, whisper, sora,
 * transcribe, first-gen Bedrock) and models.dev drops what providers retire,
 * while litellm keeps historical entries. Raise these when the seed is next
 * regenerated, never lower them without saying why here.
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

  it('joins every model id exactly once, with no id resolving to two different keys', () => {
    for (const modelId of seedModelIds) {
      const first = resolveAggregatorKey(modelId, INDEXES.litellm, aliases);
      expect(resolveAggregatorKey(modelId, INDEXES.litellm, aliases)).toEqual(first);
    }
  });
});
