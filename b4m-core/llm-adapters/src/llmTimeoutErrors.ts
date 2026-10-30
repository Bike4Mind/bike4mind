/**
 * Which of our own client-side timers gave up on the model:
 * - `first_event`: the stream opened but sent no event before the first-event deadline.
 * - `stream_idle`: the stream went silent mid-response for longer than the idle limit.
 * - `request`: the API call never started streaming.
 */
export type LlmTimeoutKind = 'first_event' | 'stream_idle' | 'request';

export type LlmStreamTimeoutKind = Exclude<LlmTimeoutKind, 'request'>;

/**
 * Usage the provider reported before the stream was cut: the cut request's prompt (message_start)
 * plus any tool rounds of the same call that completed. The cut request's own output is never known.
 */
export interface LlmTimeoutUsage {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Output of the completed tool rounds only; absent when none completed. */
  outputTokens?: number;
}

export interface LlmTimeoutDetails {
  /** Bytes (keepalive pings) were still arriving when the timer fired: the model was generating. */
  keepalive?: boolean;
  usage?: LlmTimeoutUsage;
}

/**
 * A timeout raised by our own timers, not by the provider. The model was slow or the
 * connection stalled; the provider never said it was busy, so this must never be read
 * as overload (`isOverloadedError` in utils/adminSettings/fallback.ts excludes it).
 *
 * The messages keep the "stream timeout" / "request timeout" phrases that the message-based
 * predicates in services/src/llm/llmErrorPredicates.ts and the final-error mapping in
 * ChatCompletionProcess still match (as does the "stream timeout - no (response|event) received"
 * skip in apps/workers/src/events/logToSlackClassify.ts), and must never say "overloaded" or "aborted".
 */
export class LlmTimeoutError extends Error {
  readonly keepalive: boolean;
  readonly usage?: LlmTimeoutUsage;

  constructor(
    readonly kind: LlmTimeoutKind,
    readonly timeoutMs: number,
    message: string,
    details: LlmTimeoutDetails = {}
  ) {
    super(message);
    this.name = 'LlmTimeoutError';
    this.keepalive = details.keepalive ?? false;
    this.usage = details.usage;
  }
}

/** Matches by name as well, so a second bundled copy of this class still counts. */
export function isLlmTimeoutError(error: unknown): error is LlmTimeoutError {
  return error instanceof LlmTimeoutError || (error instanceof Error && error.name === 'LlmTimeoutError');
}

/** A stream cut while the connection was still alive, so the model was generating rather than stalled. */
export function isKeepaliveStreamTimeout(error: unknown): boolean {
  return isLlmTimeoutError(error) && error.keepalive === true;
}

export function createAnthropicStreamTimeoutError(
  kind: LlmStreamTimeoutKind,
  timeoutMs: number,
  details: LlmTimeoutDetails = {}
) {
  const seconds = timeoutMs / 1000;
  const detail =
    kind === 'first_event'
      ? `no event received within ${seconds} seconds of the stream opening`
      : `no event received for ${seconds} seconds mid-response`;
  const cause = details.keepalive
    ? 'The connection stayed alive, so the model was still generating.'
    : 'The model is responding slowly.';
  return new LlmTimeoutError(kind, timeoutMs, `Anthropic API stream timeout - ${detail}. ${cause}`, details);
}

export function createAnthropicRequestTimeoutError(timeoutMs: number) {
  return new LlmTimeoutError(
    'request',
    timeoutMs,
    `Anthropic API request timeout after ${timeoutMs}ms - no streaming response received`
  );
}
