/**
 * Default result count for the model-initiated `search_knowledge_base` tool, shared between the
 * admin-settings schema in this package and the tool implementation in `@bike4mind/services` so
 * the two can't drift - the same reason `FORCED_RETRIEVAL_CHAR_BUDGET_DEFAULT` lives in its own
 * file in `forcedRetrieval.ts` instead of as a local constant.
 */

/** Passages returned when a model call omits `max_results`. The 10-result ceiling stays a
 * hardcoded constant in the tool itself: it is also the tool schema's advertised `maximum`, and
 * that schema is built synchronously, so only the default (the value most calls actually get) is
 * worth making an admin lever. */
export const KB_SEARCH_DEFAULT_RESULTS_DEFAULT = 5;

/**
 * Approximate tokens of served passage text one `search_knowledge_base` call may emit, replacing
 * the passage count as the primary bound (chunk size varies; a token budget does not). `0` is a
 * real, silent value meaning "no budget" - the passage-count default above is then the only bound,
 * byte-identical to pre-this-setting behavior - not "unset, use some other default".
 */
export const KB_SEARCH_RESULT_TOKEN_BUDGET_DEFAULT = 0;

/**
 * Minimum cosine relevance (as a whole-number percent, 0-100) a passage must clear to be returned.
 * `0` matches today's hardcoded `minScore: 0` used at both `search_knowledge_base` call sites, so
 * this default changes nothing until an admin raises it. Stored as an integer percent rather than
 * a 0-1 fraction because the admin settings number input has no `step`, which makes a fractional
 * value's spinner unusable; the resolver divides by 100 once, at the one place that consumes it.
 */
export const KB_SEARCH_MIN_RELEVANCE_PCT_DEFAULT = 0;
