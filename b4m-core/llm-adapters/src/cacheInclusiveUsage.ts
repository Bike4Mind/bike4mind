/**
 * The cache-inclusive-to-cache-exclusive conversion, shared by every adapter whose
 * provider reports cached tokens as a SUBSET of the prompt count.
 *
 * getTextModelCost expects Anthropic's convention: `inputTokens` counts only uncached
 * tokens and cache reads bill separately at their own (much cheaper) rate. Anthropic
 * and Claude-on-Bedrock deliver that natively. OpenAI and Moonshot do not - their
 * prompt total already CONTAINS the cached tokens - so those adapters must subtract
 * here before forwarding, or settlement double-bills the cached portion.
 *
 * Must stay in sync with the disjoint-fields assumption documented at the settlement
 * site in ChatCompletionProcess.
 */

/**
 * Split a cache-INCLUSIVE prompt total into the disjoint pair CompletionInfo carries.
 *
 * Forwarding the cached count without subtracting double-bills it; forwarding nothing
 * charges the full input rate on tokens the provider billed at a fraction of it.
 * Subtracting is the only split that bills what the provider actually charged.
 *
 * Clamped at zero: if a feed ever reports more cached than prompt tokens, a negative
 * input count would silently credit the user.
 */
export function splitCacheInclusiveInput(
  totalPromptTokens: number,
  cacheReadTokens: number
): { inputTokens: number; cacheReadInputTokens?: number } {
  if (cacheReadTokens <= 0) return { inputTokens: totalPromptTokens };
  const cached = Math.min(cacheReadTokens, totalPromptTokens);
  return { inputTokens: Math.max(0, totalPromptTokens - cached), cacheReadInputTokens: cached };
}

/**
 * Cached prompt tokens from a raw provider usage object, across every spelling in use:
 * OpenAI Chat Completions nests them under `prompt_tokens_details`, the OpenAI
 * Responses API under `input_tokens_details`, and Moonshot publishes a flat
 * `cached_tokens` alongside the OpenAI-shaped nesting. Reading only one spelling
 * silently bills every cache hit on the other transports at the full input rate.
 */
export function cachedTokensFromUsage(usage: Record<string, unknown> | undefined | null): number {
  if (!usage) return 0;
  const candidates: unknown[] = [
    usage.cached_tokens,
    (usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens,
    (usage.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens,
  ];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}
