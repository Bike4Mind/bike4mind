/**
 * Forced-retrieval budget and relevance defaults, shared between the admin-settings schema in this
 * package and `ChatCompletionFeatures.ts` (which cannot import from `common`'s settings schema
 * without a dependency cycle, so the constants live here instead).
 *
 * All three are levers. The char budget is the measured binding constraint on how much of a corpus
 * reaches the model on every Data-Lake-mode turn; the two floors decide which passages are eligible
 * to spend it (see `forcedRetrievalRelativeFloorPct` and `forcedRetrievalMinSimilarityPct`).
 */

/** Total characters of retrieved chunk text injected into a forced-retrieval prompt. */
export const FORCED_RETRIEVAL_CHAR_BUDGET_DEFAULT = 12_000;

/**
 * The absolute cosine floor (ada-002) the forced path applied before either floor was configurable.
 *
 * No longer read at runtime - `forcedRetrievalMinSimilarityPct` is. It stays exported as the
 * HISTORICAL anchor that `settings.test.ts` pins the percent default against, so moving that default
 * off the value production actually shipped is a deliberate, visible edit rather than a silent one.
 */
export const FORCED_RETRIEVAL_MIN_SIMILARITY_DEFAULT = 0.75;

/**
 * `FORCED_RETRIEVAL_MIN_SIMILARITY_DEFAULT` as the whole-number percent the admin setting stores.
 *
 * Percent rather than a 0-1 fraction because the admin settings number input has no `step`, which
 * makes a fractional value's spinner unusable - the same reason `KB_SEARCH_MIN_RELEVANCE_PCT_DEFAULT`
 * is a percent. The resolver divides by 100 once, at the one place that consumes it. `settings.test.ts`
 * pins this against the fraction above so the two cannot drift.
 */
export const FORCED_RETRIEVAL_MIN_SIMILARITY_PCT_DEFAULT = 75;

/**
 * How close to the turn's best-scoring passage a chunk must score to be injected, as a percent of
 * that top score. This is the floor that RANKS; the absolute one above only rejects.
 *
 * An absolute cosine floor assumes scores are spread widely enough for the line to sit somewhere
 * meaningful between "relevant" and "irrelevant". Measured over 166 injected chunks on a production
 * lake that does not hold: the whole distribution sat between 0.8025 and 0.9140 and NOTHING was ever
 * rejected by the 0.75 line, which is ~0.05 below the entire band. A fixed floor set outside the live
 * band is inert - it provides no protection while reading like a quality gate - and a corpus whose
 * band sits lower would see the opposite failure, rejecting everything.
 *
 * A relative floor moves with the turn instead of assuming where the band is, so it keeps working
 * across corpora and survives a change of embedding model (which shifts the band wholesale).
 *
 * The 85 default is BEHAVIOR-PRESERVING ON THE MEASURED BAND, not tuned: the weakest-accepted-to-top
 * ratio observed on that lake was 0.8025/0.9140 ~= 0.878, so 85% admits everything the absolute floor
 * admitted there. Read that as a claim about THAT band rather than a general no-op - the relative
 * floor binds harder than a 75 absolute floor once a turn's top score exceeds ~0.882, so a corpus
 * with a wider band can see chunks newly rejected at this default. It is a mechanism plus a
 * safe starting point, and it is meant to be tuned UPWARD once the band is known - which should
 * wait for the embedding migration (#471) and the ANN-cutover decision (#2526), both of which move
 * the distribution any value chosen today would have been fitted to.
 */
export const FORCED_RETRIEVAL_RELATIVE_FLOOR_PCT_DEFAULT = 85;

/**
 * Candidates above the ABSOLUTE floor retained for the char-budget walk, so resident chunk text
 * stays bounded. The relative floor narrows this pool further, after the scan (it needs the turn's
 * final top score), so this cap bounds memory on its own and does not depend on either floor.
 *
 * The budget can only fit this many sections while the mean retained chunk exceeds
 * (configured char budget)/256 chars - ~47 at the 12,000-char default, which real chunking always
 * clears. Since the char budget became a setting (`forcedRetrievalCharBudget`, defaulted by
 * `FORCED_RETRIEVAL_CHAR_BUDGET_DEFAULT` above), a very large configured value could in principle
 * admit more sections than this caps; a corpus of very short chunks could inject fewer than expected
 * regardless of budget.
 *
 * Lives here rather than beside the scan it bounds because the offline floor sweep
 * (`packages/scripts/retrieval/forcedFloorSweep.ts`) has to apply the same cap: the floors are
 * measured over the pool that survives it, so a harness using a different ceiling would measure a
 * cut the served path does not make.
 */
export const FORCED_RETRIEVAL_MAX_SCORED_CHUNKS = 256;
