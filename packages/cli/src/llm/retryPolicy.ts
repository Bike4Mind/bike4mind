import type { RetryPolicy } from './streamTransport';

/**
 * Connection-level failures that should be retried rather than surfaced to the
 * user. Mirrors the canonical retryable-error list in `@bike4mind/llm-adapters`
 * (retry.ts): the most common offender is a TLS socket close mid-stream, which
 * Node surfaces as `Error: aborted` thrown from `node:_http_client`
 * `socketCloseListener`. This happens when the connection sits idle during a long
 * extended-thinking step and an intermediary (or the socket itself) times out the
 * idle connection. The WebSocket path phrases its mid-stream disconnect as
 * "connection closed" so it matches here too.
 *
 * Crucially this is NOT a user cancel - those are detected separately via the
 * abort signal before this classifier is consulted. Matching is on the lowercased
 * message so we catch the various wordings undici/Node emit.
 */
const TRANSIENT_NETWORK_ERROR_PATTERNS = [
  'aborted', // TLS socket close (node:_http_client socketCloseListener)
  'socket closed',
  'socket hang up',
  'connection closed',
  'econnreset',
  'etimedout',
  'terminated',
  'network error',
  'fetch failed',
  'und_err_socket',
];

export function isTransientNetworkError(error: Error): boolean {
  const message = error.message?.toLowerCase() ?? '';
  return TRANSIENT_NETWORK_ERROR_PATTERNS.some(pattern => message.includes(pattern));
}

/** Default max retries for a transient stream failure, shared by both transports. */
export const DEFAULT_MAX_STREAM_RETRIES = 2;

/**
 * The retry policy both CLI transports pass to `runCompletion`: retry a
 * delivered-nothing attempt when the thrown error is a transient network drop.
 * Sharing one factory keeps the SSE and WebSocket paths from diverging again.
 */
export function createTransientRetryPolicy(maxRetries: number = DEFAULT_MAX_STREAM_RETRIES): RetryPolicy {
  return {
    maxRetries,
    isRetryable: error => error instanceof Error && isTransientNetworkError(error),
  };
}
