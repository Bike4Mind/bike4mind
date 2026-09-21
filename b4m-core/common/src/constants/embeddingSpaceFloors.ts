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
 *     probe queries.
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
 * behind it. 3-small at 58 is MEASURED, on a live 520-file / 21,327-chunk capture of the
 * `opti-knowledge` lake (1536 dims, 2026-09-18), swept against 30 positives authored from that
 * corpus's own passages plus screened negatives - so recall and false-positive rate come out of ONE
 * corpus snapshot rather than two. The negatives were screened by reading the served chunk TEXT,
 * which reclassified 44 of 89 as answerable; the two right-hand columns are that screen's two
 * defensible readings, counting a PARTIAL answer as answerable or as a false positive.
 *
 *      floor   recall   positives emptied   FP (45 strict neg)   FP (61 partial-as-neg)
 *      85:49   100.0%           0                 71.1%                  78.7%
 *      85:53   100.0%           0                 64.4%                  73.8%
 *      85:55    96.7%           1                 60.0%                  68.9%
 *      85:58    93.3%           2                 42.2%                  52.5%
 *      85:61    86.7%           4                 22.2%                  36.1%
 *      85:64    76.7%           7                 13.3%                  19.7%
 *      85:75    20.0%          24                  0.0%                   0.0%
 *
 * WHY 58 RATHER THAN THE SEPARATION OPTIMUM, WHICH IS 61-64. Recall here is measured on positives
 * authored FROM corpus passages, so each supporting document is the easiest possible match for its
 * own question, and this recall is an UPPER BOUND on recall against a real user's phrasing. The
 * false-positive rate, measured on screened negatives, carries no matching optimism. An optimistic
 * recall beside an honest false-positive rate biases the optimum HIGH, so the shipped floor is the
 * low end of the bracket rather than its peak.
 *
 * WHAT THE PREVIOUS 49 GOT WRONG, and it was not the magnitude. 49 emptied ZERO positives - it was
 * not buying recall protection, it simply was not cutting - while 71-79% of screened true negatives
 * still got something served. The entire range 0-53 costs no recall on this corpus, which the
 * 35-file capture 49 was fitted to could not show: its decoy column rested on 6 negatives.
 *
 * Recall above is of the ACCEPTED set, so it answers "did the floor cut the supporting document",
 * which is the floor's own question, and is NOT a claim the model saw it - the char budget and the
 * 256-chunk candidate pool cap are separate narrowings downstream of this gate.
 *
 * ada-002's 75 applied in this space would be an outage in all but name: 20% recall, 24 of 30
 * positives emptied outright. That is the per-space case above restated as a measurement.
 *
 * 3-large is deliberately absent despite having a measured band (0.2104-0.5197): the choice between
 * it and 3-small is recorded as NOT SETTLED, and guessing a floor for a space nobody has run the
 * sweep against is what this module exists to stop. Voyage, Bedrock and the Ollama self-host
 * embedders are absent for the same reason - none has ever been measured, and the 0.75 they inherit
 * today was fitted to a model none of them is.
 */
export const FORCED_RETRIEVAL_MIN_SIMILARITY_PCT_BY_SPACE = {
  [OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002]: 75,
  [OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL]: 58,
} as const satisfies CosineFloorPctByEmbeddingSpace;

// The per-space V1 memento floor table this file used to keep alongside the one above was retired
// when V1 mementos moved to a compile-time embedding pin: the floor is now a single literal,
// MEMENTO_MIN_SIMILARITY (schemas/embedding.ts), the same way V2's always was. See
// getRelevantMementos.ts for the current call site.
