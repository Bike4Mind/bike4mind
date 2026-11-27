// Message-shape predicates for LLM call failures, shared by the completion retry loop
// (ChatCompletionProcess) and the turn-timing retry classifier (turnTiming.ts).

import { isLlmTimeoutError } from '@bike4mind/llm-adapters';

export function isToolPairingError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  // Match known Anthropic tool-pairing failure patterns:
  // - messages mentioning both "tool_use" and "tool_result"
  // - messages mentioning "tool_use_id" (e.g., "unexpected tool_use_id")
  const hasToolUseAndResult = msg.includes('tool_use') && msg.includes('tool_result');
  const hasToolUseIdVariant = msg.includes('tool_use_id');
  return hasToolUseAndResult || hasToolUseIdVariant;
}

// The typed LlmTimeoutError is authoritative. The message checks stay for errors that are not
// typed: the truncation rejections (Anthropic and Bedrock, worded to match "stream timeout") and
// any other backend's wording.
export function isRequestTimeoutError(error: Error): boolean {
  if (isLlmTimeoutError(error)) return error.kind === 'request';
  return error.message.includes('request timeout') || error.message.includes('Request timeout');
}

export function isStreamIdleTimeoutError(error: Error): boolean {
  if (isLlmTimeoutError(error)) return error.kind !== 'request';
  return error.message.includes('stream timeout') || error.message.includes('Stream timeout');
}

/**
 * A stream that ended without its terminal event (Anthropic message_stop, Bedrock's terminal
 * event). Those rejections are worded "stream timeout" so the retry loop treats them like a stall,
 * but the cause is a dropped connection, not a slow model.
 */
export function isTruncatedStreamError(error: Error): boolean {
  return error.message.includes('without message_stop') || error.message.includes('without a terminal event');
}

/** A timeout our own timers raised: the model is slow, not the provider busy. */
export function isSlowModelTimeoutError(error: Error): boolean {
  return !isTruncatedStreamError(error) && (isRequestTimeoutError(error) || isStreamIdleTimeoutError(error));
}
