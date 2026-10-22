/**
 * Which of our own client-side timers gave up on the model:
 * - `first_event`: the stream opened but sent no event before the first-event deadline.
 * - `stream_idle`: the stream went silent mid-response for longer than the idle limit.
 * - `request`: the API call never started streaming.
 */
export type LlmTimeoutKind = 'first_event' | 'stream_idle' | 'request';

export type LlmStreamTimeoutKind = Exclude<LlmTimeoutKind, 'request'>;

/**
 * A timeout raised by our own timers, not by the provider. The model was slow or the
 * connection stalled; the provider never said it was busy, so this must never be read
 * as overload (`isOverloadedError` in utils/adminSettings/fallback.ts excludes it).
 *
 * The messages keep the "stream timeout" / "request timeout" phrases that the message-based
 * predicates in services/src/llm/llmErrorPredicates.ts and the final-error mapping in
 * ChatCompletionProcess still match, and must never say "overloaded" or "aborted".
 */
export class LlmTimeoutError extends Error {
  constructor(
    readonly kind: LlmTimeoutKind,
    readonly timeoutMs: number,
    message: string
  ) {
    super(message);
    this.name = 'LlmTimeoutError';
  }
}

/** Matches by name as well, so a second bundled copy of this class still counts. */
export function isLlmTimeoutError(error: unknown): error is LlmTimeoutError {
  return error instanceof LlmTimeoutError || (error instanceof Error && error.name === 'LlmTimeoutError');
}

export function createAnthropicStreamTimeoutError(kind: LlmStreamTimeoutKind, timeoutMs: number) {
  const seconds = timeoutMs / 1000;
  const detail =
    kind === 'first_event'
      ? `no event received within ${seconds} seconds of the stream opening`
      : `no event received for ${seconds} seconds mid-response`;
  return new LlmTimeoutError(
    kind,
    timeoutMs,
    `Anthropic API stream timeout - ${detail}. The model is responding slowly.`
  );
}

export function createAnthropicRequestTimeoutError(timeoutMs: number) {
  return new LlmTimeoutError(
    'request',
    timeoutMs,
    `Anthropic API request timeout after ${timeoutMs}ms - no streaming response received`
  );
}
