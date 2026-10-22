// Message-shape predicates for LLM call failures, shared by the completion retry loop
// (ChatCompletionProcess) and the turn-timing retry classifier (turnTiming.ts).

export function isToolPairingError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  // Match known Anthropic tool-pairing failure patterns:
  // - messages mentioning both "tool_use" and "tool_result"
  // - messages mentioning "tool_use_id" (e.g., "unexpected tool_use_id")
  const hasToolUseAndResult = msg.includes('tool_use') && msg.includes('tool_result');
  const hasToolUseIdVariant = msg.includes('tool_use_id');
  return hasToolUseAndResult || hasToolUseIdVariant;
}

export function isRequestTimeoutError(error: Error): boolean {
  return error.message.includes('request timeout') || error.message.includes('Request timeout');
}

export function isStreamIdleTimeoutError(error: Error): boolean {
  return error.message.includes('stream timeout') || error.message.includes('Stream timeout');
}
