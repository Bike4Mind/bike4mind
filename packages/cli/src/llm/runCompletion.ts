import { logger } from '../utils/Logger';
import { StreamAccumulator } from './streamAccumulator';
import type { CompletionCallback, CompletionRequest, RetryPolicy, StreamTransport } from './streamTransport';

/** Default base backoff between retry attempts (ms); overridable via RetryPolicy.backoffMs. */
const DEFAULT_BACKOFF_MS = 500;

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

/** User-facing message when a transient network drop survives all retries. */
const TRANSIENT_EXHAUSTED_MESSAGE =
  'The connection dropped mid-response (likely a network timeout during a long thinking step). ' +
  'It was retried automatically but kept failing - type "continue" to resume.';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The shared completion lifecycle for BOTH CLI transports. Given a
 * {@link StreamTransport} that only knows how to open a wire stream and yield
 * decoded events, this owns everything subtle that used to be duplicated (and
 * divergent) in `ServerLlmBackend` and `WebSocketLlmBackend`:
 *
 * - accumulate a turn and finalize it EXACTLY ONCE (deliver-once, no double-bill);
 * - retry a delivered-nothing attempt on a transient wire failure, with backoff;
 * - treat an empty completion as a retryable failure, never a silent blank turn
 *   (this is the WebSocket parity fix - its old path resolved empty without
 *   erroring or retrying);
 * - on abort, settle without invoking the callback.
 *
 * Exactly-once is structural, not flag-guarded: `finalize()` runs only after the
 * stream returns cleanly, and we return immediately after it, so no attempt that
 * reached delivery is ever retried. Each retry opens a fresh stream and a fresh
 * accumulator, so a mid-stream drop discards its partial content rather than
 * double-appending. A post-terminal socket error (e.g. teardown noise after an
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

    try {
      const accumulator = new StreamAccumulator();
      for await (const event of transport.open(req, signal)) {
        if (signal?.aborted) break;
        accumulator.apply(event);
      }

      // Abort mid-stream: discard partial content, settle without callback.
      if (signal?.aborted) return;

      if (!accumulator.isEmpty()) {
        await accumulator.finalize(callback);
        return; // delivered exactly once
      }

      // Empty: fall through to backoff + retry (do NOT deliver a blank turn).
      lastError = new EmptyCompletionError();
      logger.warn('[runCompletion] Stream produced no content; treating as retryable.');
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // User cancel mid-attempt: settle without surfacing an error or retrying.
      if (signal?.aborted) return;

      if (!policy.isRetryable(lastError)) throw lastError;

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
