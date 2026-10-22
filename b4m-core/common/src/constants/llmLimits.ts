/**
 * Largest legacy thinking budget (`budget_tokens`) a request may ask for. Anthropic rejects rather
 * than clamps an oversized budget, and the budget raises the max_tokens a turn is sent with, so it
 * is bounded both at the request schemas and where the adapter consumes it (buildThinkingParams).
 */
export const MAX_THINKING_BUDGET_TOKENS = 32_000;

/**
 * Most tool-call rounds a session may set (`maxToolCalls`); the adapters default to
 * DEFAULT_MAX_TOOL_CALLS (llm-adapters backend.ts). Bounded at the session schemas and clamped
 * where ChatCompletionProcess reads it, so a stored or cloned session cannot exceed it either.
 */
export const MAX_TOOL_CALLS_CEILING = 50;

/**
 * Deep Research ceilings, matching what the settings modal and research tasks offer. Bounded at
 * the request schemas and clamped in performDeepResearch, so no caller can run past them.
 */
export const DEEP_RESEARCH_MAX_DEPTH = 10;
/** In minutes. */
export const DEEP_RESEARCH_MAX_DURATION_MIN = 10;
