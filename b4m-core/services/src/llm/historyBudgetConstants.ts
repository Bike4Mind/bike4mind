/**
 * Fraction of the space ACTUALLY AVAILABLE FOR HISTORY (safe input minus the
 * non-history overhead reserved below) kept as VERBATIM conversation history
 * before older turns are folded into contextSummary. The fraction tunes the
 * verbatim/summary split of whatever room is left after overhead; it is NOT a
 * fraction of the raw window. Overridable per-deploy via the
 * ContextVerbatimWindowFraction admin setting.
 */
export const DEFAULT_VERBATIM_WINDOW_FRACTION = 0.55;

/**
 * Non-history input competes with the verbatim window for the same safe-input
 * budget: system prompts, tool schemas, the injected contextSummary, and the
 * current prompt. The verbatim budget must reserve room for these or the window
 * grows until history ALONE nears safe input while total input has already
 * overflowed - the turn then hits the hard overflow guard (which throws before
 * the reactive summarizer's onComplete can run) instead of compacting. These are
 * conservative floors used only to pick the summary boundary; the exact tokenizer
 * still enforces the real budget downstream in buildAndSortMessages.
 */
export const SYSTEM_PROMPT_RESERVE_TOKENS = 1200; // persona + artifact/help/date guidance, typical floor
