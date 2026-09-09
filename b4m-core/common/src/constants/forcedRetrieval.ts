/**
 * Forced-retrieval budget defaults, shared between the admin-settings schema in this package and
 * `ChatCompletionFeatures.ts` (which cannot import from `common`'s settings schema without a
 * dependency cycle, so the constant lives here instead).
 *
 * Only `FORCED_RETRIEVAL_CHAR_BUDGET_DEFAULT` is a lever (see the `forcedRetrievalCharBudget`
 * setting) - the char budget is the measured binding constraint on how much of a corpus reaches
 * the model on every Data-Lake-mode turn. The relevance floor is exported alongside it so the two
 * stay next to each other, not because it is tunable today.
 */

/** Total characters of retrieved chunk text injected into a forced-retrieval prompt. */
export const FORCED_RETRIEVAL_CHAR_BUDGET_DEFAULT = 12_000;

/** Minimum cosine similarity (ada-002) for a chunk to count as relevant on the forced path. */
export const FORCED_RETRIEVAL_MIN_SIMILARITY_DEFAULT = 0.75;
