import { describe, it, expect } from 'vitest';
import { isTransientNetworkError, createTransientRetryPolicy, DEFAULT_MAX_STREAM_RETRIES } from './retryPolicy';

/**
 * The classifier decides whether a streaming failure is a transient network
 * drop (retry + recover) vs. a real error to surface. The headline case is the
 * `Error: aborted` thrown by `node:_http_client` when a TLS socket closes
 * mid-stream during a long thinking step - previously this leaked through and
 * rendered as a cryptic bare "aborted".
 */
describe('isTransientNetworkError', () => {
  it('classifies the bare TLS-socket-close "aborted" error as transient', () => {
    expect(isTransientNetworkError(new Error('aborted'))).toBe(true);
  });

  it('matches the common connection-level failure messages', () => {
    const transient = [
      'aborted',
      'socket closed',
      'socket hang up',
      'connection closed',
      'read ECONNRESET',
      'connect ETIMEDOUT 10.0.0.1:443',
      'The operation was terminated',
      'network error',
      'fetch failed',
      'UND_ERR_SOCKET: other side closed',
      // The WebSocket path's mid-stream disconnect must classify as transient so
      // it retries like the SSE path - see WebSocketLlmBackend.streamCompletion.
      'WebSocket connection closed during completion',
      // A retry that races auto-reconnect hits this at open(); it must be retryable
      // so the core waits out another backoff window instead of short-circuiting.
      'WebSocket is not connected',
    ];
    for (const message of transient) {
      expect(isTransientNetworkError(new Error(message)), message).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    expect(isTransientNetworkError(new Error('ABORTED'))).toBe(true);
    expect(isTransientNetworkError(new Error('Socket Hang Up'))).toBe(true);
  });

  it('does not flag real, non-transient errors', () => {
    const realErrors = [
      'Authentication failed',
      'Stream ended prematurely without receiving any data. The server may be experiencing issues.',
      'Server error: invalid model',
      'Unexpected token in JSON',
      '',
    ];
    for (const message of realErrors) {
      expect(isTransientNetworkError(new Error(message)), message).toBe(false);
    }
  });
});

describe('createTransientRetryPolicy', () => {
  it('defaults to the shared max-retries and retries only transient errors', () => {
    const policy = createTransientRetryPolicy();
    expect(policy.maxRetries).toBe(DEFAULT_MAX_STREAM_RETRIES);
    expect(policy.isRetryable(new Error('socket hang up'))).toBe(true);
    expect(policy.isRetryable(new Error('Authentication failed'))).toBe(false);
    expect(policy.isRetryable('not an error')).toBe(false);
  });

  it('honors an explicit max-retries override', () => {
    expect(createTransientRetryPolicy(5).maxRetries).toBe(5);
  });
});
