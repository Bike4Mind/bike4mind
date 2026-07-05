import { describe, it, expect } from 'vitest';
import { isTransientNetworkError } from './ServerLlmBackend';

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
