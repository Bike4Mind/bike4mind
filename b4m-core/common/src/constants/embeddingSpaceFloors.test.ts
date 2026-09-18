import { describe, expect, it } from 'vitest';
import { FORCED_RETRIEVAL_MIN_SIMILARITY_PCT_BY_SPACE, cosineFloorPctForSpace } from './embeddingSpaceFloors';
import { FORCED_RETRIEVAL_MIN_SIMILARITY_PCT_DEFAULT } from './forcedRetrieval';
import { OpenAIEmbeddingModel, OllamaEmbeddingModel, VoyageAIEmbeddingModel } from '../schemas/embedding';

/**
 * The top of each space's MEASURED cosine band over the FILE corpus, as whole-number percents, from
 * the two captures in `packages/scripts/retrieval/MODEL-COMPARISON.md`. A floor at or above one of
 * these rejects every chunk on every query in that space - the silent outage this module exists to
 * make impossible - so these are the numbers every shipped FORCED-RETRIEVAL floor is checked
 * against below. They say nothing about the memento corpus; see the check itself for why.
 *
 * The captures are not reproducible from a clean clone (`packages/scripts/out/` is gitignored and
 * re-making it costs real provider spend), which is exactly why the result is pinned here rather
 * than re-derived: this test is the only thing standing between a future edit and a repeat of the
 * outage. ada-002's figure is the higher PRODUCTION-lake band max, not the help corpus's 0.8110 -
 * the stricter bound of the two would be wrong to assert against, since a floor only has to clear
 * the band of the corpus it is actually applied to.
 */
const MEASURED_BAND_MAX_PCT: Readonly<Record<string, number>> = {
  [OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002]: 91.4,
  [OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL]: 55.88,
};

describe('cosineFloorPctForSpace', () => {
  it('returns the measured floor for a space that has one', () => {
    expect(
      cosineFloorPctForSpace(FORCED_RETRIEVAL_MIN_SIMILARITY_PCT_BY_SPACE, OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002)
    ).toBe(75);
    expect(
      cosineFloorPctForSpace(FORCED_RETRIEVAL_MIN_SIMILARITY_PCT_BY_SPACE, OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL)
    ).toBe(49);
  });

  // The whole contract. `noUncheckedIndexedAccess` is off in this repo, so a bare `TABLE[space]`
  // types as `number` and hands the caller a confident `undefined`; callers branch on this being
  // reported honestly to decide they must gate on the relative floor alone.
  it('reports absence for a space nobody has measured', () => {
    for (const space of [
      OpenAIEmbeddingModel.TEXT_EMBEDDING_3_LARGE,
      VoyageAIEmbeddingModel.VOYAGE_3_LARGE,
      OllamaEmbeddingModel.QWEN3_EMBEDDING_0_6B,
    ]) {
      expect(cosineFloorPctForSpace(FORCED_RETRIEVAL_MIN_SIMILARITY_PCT_BY_SPACE, space)).toBeUndefined();
    }
  });

  // `space` arrives from stored chunk data (`fabfilechunks.embeddingModel`), so a document stamped
  // with an Object.prototype member must read as unmeasured rather than resolving to a function.
  it('does not resolve inherited object members as floors', () => {
    for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(cosineFloorPctForSpace(FORCED_RETRIEVAL_MIN_SIMILARITY_PCT_BY_SPACE, key)).toBeUndefined();
    }
  });

  it('reports absence for a space with no recorded floor rather than a default of 0', () => {
    expect(
      cosineFloorPctForSpace(FORCED_RETRIEVAL_MIN_SIMILARITY_PCT_BY_SPACE, OpenAIEmbeddingModel.TEXT_EMBEDDING_3_LARGE)
    ).toBeUndefined();
  });
});

describe('shipped floors sit inside the band they gate', () => {
  // ONLY the forced-retrieval table. The bands above were measured over the FILE corpus, and
  // checking the memento floors against them would be the same category error this module exists
  // to name: a memento is one sentence and a chunk is a passage, so they do not share a band even
  // inside one vector space. No memento-corpus band has been captured, so those entries cannot be
  // checked this way - asserting them here would pass by luck and read as coverage.
  it('no forced-retrieval floor is at or above its space band max', () => {
    for (const [space, floorPct] of Object.entries(FORCED_RETRIEVAL_MIN_SIMILARITY_PCT_BY_SPACE)) {
      const bandMaxPct = MEASURED_BAND_MAX_PCT[space];
      // A space with no recorded band max cannot be checked; it should not be carrying a floor
      // either, so failing here is the intended outcome rather than a skip.
      expect(bandMaxPct, `no measured band recorded for "${space}" - do not ship a floor for it`).toBeDefined();
      expect(
        floorPct,
        `"${space}" floor ${floorPct}% is at or above its measured band max ${bandMaxPct}% - it would reject every chunk on every query`
      ).toBeLessThan(bandMaxPct);
    }
  });
});

describe('behavior preservation on the model in production today', () => {
  // ada-002 is no longer `defaultEmbeddingModelForEnv()`'s cloud default, but it is still the space
  // every legacy corpus sits in, so this entry is what an un-migrated lake resolves to. It must
  // equal the setting's declared default, or a deploy would move the floor under a corpus nobody
  // re-embedded rather than only under a model migration.
  it('resolves the ada-002 forced floor to the declared setting default', () => {
    expect(
      cosineFloorPctForSpace(FORCED_RETRIEVAL_MIN_SIMILARITY_PCT_BY_SPACE, OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002)
    ).toBe(FORCED_RETRIEVAL_MIN_SIMILARITY_PCT_DEFAULT);
  });
});
