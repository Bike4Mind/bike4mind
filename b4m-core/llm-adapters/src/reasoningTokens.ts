/**
 * Reasoning-token extraction for CompletionInfo.reasoningTokens.
 *
 * The count is a SUBSET of the output tokens the provider already bills, so it is
 * informational only and never feeds settlement. `undefined` means the provider
 * reported nothing; callers must forward that as an absent field, never as 0.
 *
 * The subset invariant is relative to each adapter's normalized `outputTokens`,
 * not the provider's raw fields: xAI reports `reasoning_tokens` apart from, not
 * inside, `completion_tokens`, so an xAI adapter that wires this up must fold it
 * into its `outputTokens` first or the two would diverge.
 */

function readCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Reasoning tokens from a raw provider usage object, across every spelling in use:
 * Anthropic `output_tokens_details.thinking_tokens`, OpenAI Chat Completions
 * `completion_tokens_details.reasoning_tokens`, OpenAI Responses
 * `output_tokens_details.reasoning_tokens`, and Gemini `thoughtsTokenCount`.
 */
export function reasoningTokensFromUsage(usage: unknown): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const outputDetails = u.output_tokens_details as Record<string, unknown> | null | undefined;
  const completionDetails = u.completion_tokens_details as Record<string, unknown> | null | undefined;
  return (
    readCount(outputDetails?.thinking_tokens) ??
    readCount(outputDetails?.reasoning_tokens) ??
    readCount(completionDetails?.reasoning_tokens) ??
    readCount(u.thoughtsTokenCount)
  );
}

/** Sum across tool turns; stays undefined only while no turn has reported a count. */
export function addReasoningTokens(accum: number | undefined, turn: number | undefined): number | undefined {
  if (accum === undefined) return turn;
  if (turn === undefined) return accum;
  return accum + turn;
}

/** Spread into a CompletionInfo so an unreported count leaves the key absent. */
export function reasoningTokensField(count: number | undefined): { reasoningTokens?: number } {
  return count === undefined ? {} : { reasoningTokens: count };
}
