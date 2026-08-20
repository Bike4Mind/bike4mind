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
