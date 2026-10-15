import { logger } from '../utils/Logger';
import { StreamAccumulator } from './streamAccumulator';
import type { CompletionCallback, CompletionRequest, RetryPolicy, StreamTransport } from './streamTransport';

/** Default base backoff between retry attempts (ms); overridable via RetryPolicy.backoffMs. */
const DEFAULT_BACKOFF_MS = 500;

/** Minimum gap between streamed text deltas (ms): coalesces token-sized frames so the TUI re-renders ~20x/s, not per token. */
const TEXT_FLUSH_INTERVAL_MS = 50;

/**
 * Thrown when an attempt's stream ended without producing any content (no text,
 * no tools). Treated as retryable inside {@link runCompletion}; if every attempt
 * comes back empty it surfaces to the caller rather than delivering a blank turn.
 */
export class EmptyCompletionError extends Error {
  constructor() {
    super('Stream ended without producing any content.');
    this.name = 'EmptyCompletionError';
  }
}

/**
 * Thrown when a stream finished normally (it carried a stop reason) but produced no reply,
 * e.g. a reasoning model that spent its whole output budget thinking: the server drops
 * reasoning text, so such a turn arrives blank. Not retried - the same request would
 * finish the same way and be billed again.
 */
export class NoReplyCompletionError extends Error {
  constructor(readonly stopReason: string) {
    super(
      stopReason === 'max_tokens'
        ? 'The model used its whole output limit on reasoning and produced no reply. Raise the max tokens setting or ask a narrower question.'
        : `The model finished (stop reason: ${stopReason}) without producing a reply.`
    );
    this.name = 'NoReplyCompletionError';
  }
}

/** User-facing message when a transient network drop survives all retries. */
const TRANSIENT_EXHAUSTED_MESSAGE =
  'The connection dropped mid-response (likely a network timeout during a long thinking step). ' +
  'It was retried automatically but kept failing - type "continue" to resume.';

/** User-facing message when the connection drops after part of the reply was already shown. */
const DROPPED_AFTER_STREAMING_MESSAGE =
  'The connection dropped mid-response, after part of the reply was shown, so it could not be retried ' +
  'automatically - type "continue" to resume.';

/** Thrown when the caller aborts after text was streamed, so the partial text is not taken as the answer. */
function abortError(): Error {
  const error = new Error('The completion was aborted mid-response.');
  error.name = 'AbortError';
  return error;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The shared completion lifecycle for BOTH CLI transports. Given a
 * {@link StreamTransport} that only knows how to open a wire stream and yield
 * decoded events, this owns everything subtle that used to be duplicated (and
 * divergent) in `ServerLlmBackend` and `WebSocketLlmBackend`:
 *
 * - stream visible text to the callback as deltas, at most every
 *   {@link TEXT_FLUSH_INTERVAL_MS}, then finalize the turn EXACTLY ONCE with the
 *   remaining text, tools and usage (deliver-once, no double-bill);
 * - retry a delivered-nothing attempt on a transient wire failure, with backoff;
 * - treat an empty completion as a retryable failure, never a silent blank turn
 *   (this is the WebSocket parity fix - its old path resolved empty without
 *   erroring or retrying);
 * - on abort, settle without invoking the callback - or, once text was streamed,
 *   reject with an `AbortError` so the agent does not keep the partial reply.
 *
 * Exactly-once is structural, not flag-guarded: `finalize()` runs only after the
 * stream returns cleanly, and we return immediately after it, so no attempt that
 * reached delivery is ever retried. The first streamed delta is the point of no
 * return: the agent has already appended it, so a later failure surfaces instead
 * of retrying (a retry would replay the text on top of itself). Before that point
 * each retry opens a fresh stream and a fresh accumulator, so a drop discards its
 * partial content rather than double-appending. A post-terminal socket error (e.g. teardown noise after an
 * SSE `[DONE]`) can't resurrect a delivered turn into a retry because the bridge
 * is first-settle-wins (see streamBridge.ts).
 *
 * `signal` is the caller's `options.abortSignal`; it is threaded to the transport
 * and consulted between events so a cancel stops promptly without delivering.
 */
export async function runCompletion(
  transport: StreamTransport,
  req: CompletionRequest,
  callback: CompletionCallback,
  policy: RetryPolicy,
  signal?: AbortSignal
): Promise<void> {
  // Abort before start: settle without invoking the callback.
  if (signal?.aborted) return;

  const backoffMs = policy.backoffMs ?? DEFAULT_BACKOFF_MS;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    if (attempt > 0) {
      logger.warn(`[runCompletion] Retrying stream (attempt ${attempt + 1}/${policy.maxRetries + 1})...`);
    }

    const accumulator = new StreamAccumulator();
    try {
      let lastFlushAt = 0;
      for await (const event of transport.open(req, signal)) {
        if (signal?.aborted) break;
        accumulator.apply(event);
        const now = Date.now();
        if (accumulator.hasUndeliveredText && now - lastFlushAt >= TEXT_FLUSH_INTERVAL_MS) {
          lastFlushAt = now;
          await accumulator.flushText(callback);
        }
      }

      // Abort mid-stream: discard partial content, settle without callback.
      if (signal?.aborted) {
        if (accumulator.hasDeliveredText) throw abortError();
        return;
      }

      if (!accumulator.isEmpty()) {
        await accumulator.finalize(callback);
        return; // delivered exactly once
      }

      // Empty but finished normally: retrying would repeat (and re-bill) the same outcome.
      if (accumulator.finalStopReason) throw new NoReplyCompletionError(accumulator.finalStopReason);

      // Empty with no terminal metadata: fall through to backoff + retry (do NOT deliver a blank turn).
      lastError = new EmptyCompletionError();
      logger.warn('[runCompletion] Stream produced no content; treating as retryable.');
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // User cancel mid-attempt: settle without surfacing an error or retrying.
      if (signal?.aborted) {
        if (accumulator.hasDeliveredText) throw abortError();
        return;
      }

      if (accumulator.hasDeliveredText) {
        if (!policy.isRetryable(lastError)) throw lastError;
        logger.error('[runCompletion] Stream dropped after text was streamed; not retrying', lastError);
        throw new Error(DROPPED_AFTER_STREAMING_MESSAGE);
      }

      if (lastError instanceof NoReplyCompletionError || !policy.isRetryable(lastError)) throw lastError;

      logger.warn(`[runCompletion] Transient stream failure (attempt ${attempt + 1}): ${lastError.message}`);
    }

    // Linear backoff so we don't immediately re-hit a flapping connection.
    // Shared by both the empty and retryable-error paths; skipped after the last.
    if (attempt < policy.maxRetries && backoffMs > 0) {
      await sleep(backoffMs * (attempt + 1));
    }
  }

  // Retries exhausted. Give a transient network drop a clear, actionable message
  // instead of the bare socket error; an empty completion surfaces as-is.
  if (lastError && policy.isRetryable(lastError) && !signal?.aborted) {
    logger.error('[runCompletion] Stream failed after all retries due to a network drop', lastError);
    throw new Error(TRANSIENT_EXHAUSTED_MESSAGE);
  }
  throw lastError ?? new Error('Stream failed after all retry attempts');
}
