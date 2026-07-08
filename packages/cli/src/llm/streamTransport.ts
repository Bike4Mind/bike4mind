import type { IMessage } from '@bike4mind/common';
import type { ICompletionOptions, CompletionInfo } from '@bike4mind/llm-adapters';
import type { StreamEvent } from './streamEvents';

/**
 * Ports & adapters for CLI streaming completions.
 *
 * Both transports - `ServerLlmBackend` (SSE) and `WebSocketLlmBackend` (HTTP
 * POST + WebSocket frames) - used to reimplement the same "turn a stream into
 * exactly one delivered completion" policy inline, and the two had diverged
 * (retry, deliver-exactly-once, and empty-completion handling all differed).
 *
 * This module defines the seam that fixes that: a transport is reduced to the
 * ONE thing it alone can do - open a wire stream and decode frames into the
 * shared {@link StreamEvent} union - behind {@link StreamTransport}. The retry
 * / accumulate / finalize-exactly-once / empty / abort policy lives once in
 * `runCompletion` (see runCompletion.ts) and both transports inherit it.
 */

/**
 * Completion callback the agent supplies. Matches the `callback` parameter of
 * `ICompletionBackend.complete` exactly, so a backend can forward it verbatim.
 */
export type CompletionCallback = (text: (string | null | undefined)[], info?: CompletionInfo) => Promise<void>;

/**
 * Everything one completion attempt needs. Identical across transports - it is
 * just the first three arguments of `ICompletionBackend.complete` bundled into
 * an object so the port has a single request parameter.
 */
export interface CompletionRequest {
  model: string;
  messages: IMessage[];
  options: Partial<ICompletionOptions>;
}

/**
 * The ONLY thing a transport must provide: open a stream for a single attempt
 * and yield decoded {@link StreamEvent}s until the turn is done or the wire
 * fails.
 *
 * Contract (the core relies on all three):
 * - Normal completion: the async iterable RETURNS after yielding every event
 *   (an SSE `[DONE]` / a `cli_completion_done` frame ends iteration).
 * - Wire failure: the iterable THROWS. `runCompletion` classifies the thrown
 *   error via the retry policy - a transient drop is retried, a real server
 *   error propagates. A server-sent `error` frame is surfaced as a throw, NOT
 *   yielded, because it terminates the stream.
 * - Abort: when `signal` aborts, the iterable stops (returns) promptly; the
 *   core, seeing the aborted signal, settles without invoking the callback.
 *
 * `open()` may be called more than once for the same request - once per retry
 * attempt - so it must start a fresh stream each call and hold no cross-attempt
 * state.
 */
export interface StreamTransport {
  open(req: CompletionRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
}

/**
 * Retry policy injected into `runCompletion`: how many times to re-open the
 * stream after a delivered-nothing attempt, and which thrown errors are worth
 * retrying (a transient network drop) vs. surfacing (a real server error).
 */
export interface RetryPolicy {
  /** Max re-opens after the first attempt (so total attempts = maxRetries + 1). */
  maxRetries: number;
  /** True when a thrown error is a transient wire failure worth retrying. */
  isRetryable(error: unknown): boolean;
}
