/**
 * Lake-memory recall defaults, shared between the admin-settings schema in this package and
 * `ChatCompletionFeatures.ts` (which cannot import from `common`'s settings schema without a
 * dependency cycle, so the constant lives here instead - same reason `forcedRetrieval.ts` exists).
 */

/**
 * Beliefs the lake-memory hot-card may inject per turn, shared across every lake in scope.
 *
 * 8 was inherited verbatim from user-memento recall, where it is a sensible number of facts about
 * one person; lake memory is reference material extracted from a document corpus, and 8 one-liners
 * split across two or more lakes is very little grounding. 24 is deliberately a 3x raise rather
 * than a measured optimum - nothing has ever varied this - and it anchors on the sibling block's
 * size: at the 500-char per-fact cap in `buildLakeMemoryContext`, 24 beliefs is a ~12,000-char
 * worst case, the same order as `FORCED_RETRIEVAL_CHAR_BUDGET_DEFAULT` injected on the same turn.
 */
export const LAKE_RECALL_K_DEFAULT = 24;

/**
 * Write-time ceiling for the belief budget. Not a technical limit - `recall` will happily return
 * more - but a fat-fingered extra zero (24 -> 240) has the same failure mode the forced-retrieval
 * budget's `max` exists to stop: nothing rejects the value, and the oversized system block is not
 * something the overflow-guard safety net can shed. `dropOldestHistoryTurn` only ever slices
 * conversation turns, so the turn silently loses history and then hard-errors once fewer than two
 * turns remain - a symptom that looks nothing like a misconfigured setting.
 *
 * 200 x the 500-char per-fact cap in `buildLakeMemoryContext` is ~100,000 chars, matching
 * `forcedRetrievalCharBudget`'s own declared ceiling for the retrieval block alongside it. A dated
 * card adds a fixed `(document dated YYYY-MM-DD)` suffix per fact, so the rendered block runs a few
 * percent over that figure - the ceiling is the order of magnitude, not a byte budget.
 */
export const LAKE_RECALL_K_MAX = 200;
