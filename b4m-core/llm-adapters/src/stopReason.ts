// Normalizes each provider's native finish/stop signal onto the vocabulary
// documented on `CompletionInfo.stopReason` (backend.ts). The client's
// CLEAN_FINISH_REASONS (PromptReplies.tsx) treats 'end_turn' | 'stop' | 'tool_use' |
// 'stop_sequence' as a clean finish; anything else - importantly 'max_tokens' -
// falls through to the truncation heuristic. Unrecognized provider values pass
// through unchanged, which still behaves correctly since they're absent from
// the clean set.

/** OpenAI Chat Completions `finish_reason` (also covers xAI, which shares the same API shape). */
export function normalizeOpenAIFinishReason(reason: string | null | undefined): string | undefined {
  if (!reason) return undefined;
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    default:
      return reason;
  }
}

/** Gemini `candidates[].finishReason`. */
export function normalizeGeminiFinishReason(reason: string | null | undefined): string | undefined {
  if (!reason) return undefined;
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'max_tokens';
    default:
      return reason;
  }
}

/** Ollama `done_reason` (chat/generate responses). */
export function normalizeOllamaDoneReason(reason: string | null | undefined): string | undefined {
  if (!reason) return undefined;
  switch (reason) {
    case 'length':
      return 'max_tokens';
    default:
      return reason;
  }
}

/**
 * OpenAI Responses API `incomplete_details.reason` (documented values:
 * 'max_output_tokens' | 'content_filter'). Unlike the other normalizers, absence of a
 * reason is itself meaningful here: `incomplete_details` is only present at all when the
 * response is incomplete, so no reason means a genuinely completed response - 'stop'.
 * A present-but-unrecognized reason (e.g. 'content_filter', or a future value) must NOT
 * default to 'stop' - that would wrongly mark an incomplete response as clean.
 */
export function normalizeOpenAIResponsesStopReason(incompleteReason: string | null | undefined): string {
  if (!incompleteReason) return 'stop';
  if (incompleteReason === 'max_output_tokens') return 'max_tokens';
  return incompleteReason;
}
