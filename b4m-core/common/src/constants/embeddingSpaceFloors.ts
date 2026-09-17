import { OpenAIEmbeddingModel } from '../schemas/embedding';

/**
 * Raw-cosine relevance floors, keyed to the embedding space the scores they gate were produced in.
 *
 * WHY THIS FILE EXISTS. A cosine floor is a property of a vector space, not of the retrieval system
 * that applies it. `MEMENTO_MIN_SIMILARITY` (`schemas/embedding.ts`) already records that rule for
 * the V2 memento corpus, where the space is a compile-time pin (`MEMENTO_EMBEDDING_ID`) and the
 * floor can therefore sit next to it as a sibling constant. Every corpus keyed off the
 * `defaultEmbeddingModel` ADMIN SETTING needs the same glue WITHOUT that pin: the space is chosen
 * at runtime, changes under an operator's hand, and can differ between two turns of one deployment
 * while a migration is in flight.
 *
 * A floor that does not move with its space fails in one of two directions, both silent:
 *   - ABOVE the band: every candidate is rejected and retrieval goes dark while every log line
 *     still reads "no relevant content found". Measured, not hypothesised - ada-002's shipped 0.75
 *     sits above the whole of `text-embedding-3-small`'s 0.2293-0.5588 band and empties 30 of 30
 *     probe queries (`packages/scripts/retrieval/MODEL-COMPARISON.md`).
 *   - BELOW the band: the gate rejects nothing while reading like a quality filter. The same 75 on
 *     a production lake whose band sat at 0.8025-0.9140 never once bound.
 * Same setting, same model, opposite failures on two corpora. `MEMENTO_MIN_SIMILARITY`'s header
 * records the two times this codebase has already shipped the first one; the tables below exist so
 * the embedding migration is not the third.
 *
 * THE KEY IS THE SPACE, AND TODAY THE SPACE IS THE MODEL ID. Mementos key on `model@dims` because
 * they truncate to 512. The file corpus stores full-width vectors and records the bare model id in
 * two places - `fabfilechunks.embeddingModel` per chunk, and `fabfiles.embeddingModel` on the
 * parent - so the model alone identifies the space here. Forced retrieval keys off the PARENT
 * label, which is what `resolveMajorityEmbeddingModel` votes over; that label is written at
 * chunk-commit time and records intent rather than proving where the vectors landed, so it
 * identifies a space per FILE and not per chunk. If a `dimensions` parameter is ever introduced on
 * this path these keys MUST widen to match: two vectors both honestly labelled
 * `text-embedding-3-small`, one 1536 wide and one 512, are different spaces, and cosine between
 * them scores noise rather than similarity.
 *
 * AN ABSENT ENTRY IS AN ANSWER, NOT AN OVERSIGHT. There is no floor that is safe across unmeasured
 * spaces, so lookup reports absence instead of substituting a shared fallback. The measurement is
 * explicit that neighbouring floors do not transfer: the memento floor of 0.25 sits BELOW the file
 * corpus's negative-example top of 0.3615 and would admit exactly the noise the gate exists to
 * reject. Each caller decides what an unmeasured space means for its own path, out loud.
 */

/** Whole-number percents, matching the unit the admin settings store. See `cosineFloorPctForSpace`. */
export type CosineFloorPctByEmbeddingSpace = Readonly<Record<string, number>>;

/**
 * The floor measured for `space`, or `undefined` when nobody has measured one.
 *
 * A function rather than an exported record for callers to index directly, because
 * `noUncheckedIndexedAccess` is off in this repo: a bare `TABLE[space]` types as `number`, so the
 * miss would flow onward as a confident value and reintroduce the exact silence this module exists
 * to prevent. Returning `number | undefined` makes the compiler force the decision.
 *
 * `hasOwnProperty` rather than a truthiness check because `space` arrives from stored chunk data:
 * a document stamped `constructor` or `toString` would otherwise resolve to an inherited member
 * instead of missing.
 */
export function cosineFloorPctForSpace(table: CosineFloorPctByEmbeddingSpace, space: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(table, space) ? table[space] : undefined;
}

/**
 * Absolute floors for the FILE/RAG corpus that forced retrieval scans, by embedding space.
 *
 * Backs the `forcedRetrievalMinSimilarityPct` default. An operator's explicit value still wins -
 * this is what "unset" resolves to, and the reason the setting cannot simply carry one static
 * default any more.
 *
 * ada-002 at 75 is the value production shipped and the only one with a production-lake history
 * behind it. 3-small at 49 is PROVISIONAL: measured on a 35-file eval lake capture (median chunk
 * 1424 chars, p90 2180 - the right length regime, unlike the 638-char `system-help` capture the
 * first version of this number was fitted to). The curve it was chosen from, with the emptied count
 * split into decoys suppressed (negatives) and real answers lost (positives):
 *
 *      floor    emptied   decoys   real losses   recall   MRR
 *      85:35        0        0          0         93.8%   0.774
 *      85:41        3        0          3         89.6%   0.743
 *      85:45        5        1          4         87.5%   0.722
 *      85:47        6        2          4         87.5%   0.722
 *      85:49        8        4          4         87.5%   0.722
 *      85:53       11        5          6         83.3%   0.680
 *
 * Real losses saturate at 4 by floor 45 and stay flat through 49 while decoy suppression climbs 1
 * to 4, so 49 is free against 45 and 47 and is the last point before real losses resume - it trades
 * 6.3 points of recall (against 35) for suppressing 4 of 6 decoys, paying recall for false-positive
 * suppression on purpose: the abstention prompt (`forcedRetrievalAbstention.ts`) makes an emptied
 * question an honest miss rather than the answer-ungrounded fabrication its own docblock records as
 * the prior bug.
 *
 * KEEP THE PROVISIONAL MARKER, AND HERE IS WHY IT STAYS. The decoy column is the whole argument for
 * 49 over 45, and its denominator is 6 negatives against 48 positives - four of six is a strong
 * signal on six observations, not a population rate. The recall side is the better-supported half.
 * 49 is the right number to ship off this table, but it is not yet a measured floor in the sense 75
 * is for ada-002. A re-measure on a live lake with a larger negative set is the evidence this n=6
 * cannot supply; only that re-measure (`packages/scripts/retrieval/forcedFloorSweep.ts` is the tool)
 * earns the marker's removal.
 *
 * 3-large is deliberately absent despite having a measured band (0.2104-0.5197): the choice between
 * it and 3-small is recorded as NOT SETTLED, and guessing a floor for a space nobody has run the
 * sweep against is what this module exists to stop. Voyage, Bedrock and the Ollama self-host
 * embedders are absent for the same reason - none has ever been measured, and the 0.75 they inherit
 * today was fitted to a model none of them is.
 */
export const FORCED_RETRIEVAL_MIN_SIMILARITY_PCT_BY_SPACE = {
  [OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002]: 75,
  [OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL]: 49,
} as const satisfies CosineFloorPctByEmbeddingSpace;

/**
 * Topicality floors for the V1 memento corpus, by embedding space.
 *
 * Separate from the file table above because the two corpora are different populations, not
 * different sizes of one: a memento is a single short sentence and a chunk is a passage of a
 * document, so their score distributions differ even inside one vector space. Sharing a table would
 * be the same category error as reusing `MEMENTO_MIN_SIMILARITY` on files, which the measurement
 * rejects outright.
 *
 * V1 mementos embed with whatever `defaultEmbeddingModel` names - unlike V2, which pins
 * `MEMENTO_EMBEDDING_MODEL` precisely so memory can migrate independently - which is what puts this
 * legacy path in the blast radius of a setting change it has no say in.
 *
 * Only ada-002 has a number, and it is the 0.75 both V1 call sites hardcoded rather than anything
 * measured. No other space has been measured for this corpus at all, so every other one resolves to
 * absent and the callers fall back to ranking alone. That is a real loss of precision and it is
 * still the right default: V1's floor is the whole reason it stays quiet on an off-topic question,
 * but a floor above the band does not keep it quiet, it makes memory vanish.
 */
export const MEMENTO_V1_MIN_SIMILARITY_PCT_BY_SPACE = {
  [OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002]: 75,
} as const satisfies CosineFloorPctByEmbeddingSpace;
