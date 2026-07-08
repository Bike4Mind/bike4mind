import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';
import { isTransientNetworkError, ServerLlmBackend } from './ServerLlmBackend';
import type { ApiClient } from '../auth/ApiClient';
import type { CompletionRequest } from './streamTransport';
import type { StreamEvent } from './streamEvents';

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

/**
 * Adapter-level tests for the SSE transport seam: `open()` must turn the
 * push-based eventsource-parser + response stream into a pull-based iterable of
 * decoded events, ending on `[DONE]` and throwing a server `error` event. The
 * accumulate/retry/finalize policy is covered once in runCompletion.test.ts.
 */
describe('ServerLlmBackend SSE transport (open)', () => {
  const req: CompletionRequest = { model: 'test-model', messages: [], options: {} };

  const backendWith = (stream: PassThrough): ServerLlmBackend => {
    const apiClient = {
      getAxiosInstance: () => ({ post: async () => ({ status: 200, statusText: 'OK', data: stream }) }),
    } as unknown as ApiClient;
    return new ServerLlmBackend({ apiClient, model: 'test-model', completionsUrl: '/completions' });
  };

  const collect = async (backend: ServerLlmBackend): Promise<StreamEvent[]> => {
    const events: StreamEvent[] = [];
    for await (const event of backend.open(req)) events.push(event);
    return events;
  };

  it('yields decoded content events and ends on [DONE]', async () => {
    const stream = new PassThrough();
    const done = collect(backendWith(stream));
    stream.write(`data: ${JSON.stringify({ type: 'content', text: 'Hello' })}\n\n`);
    stream.write(`data: ${JSON.stringify({ type: 'content', text: ' world' })}\n\n`);
    stream.write('data: [DONE]\n\n');
    stream.end();
    expect(await done).toEqual([
      { type: 'content', text: 'Hello' },
      { type: 'content', text: ' world' },
    ]);
  });

  it('throws when the server sends an error event', async () => {
    const stream = new PassThrough();
    const done = collect(backendWith(stream));
    stream.write(`data: ${JSON.stringify({ type: 'error', message: 'model overloaded' })}\n\n`);
    stream.end();
    await expect(done).rejects.toThrow('model overloaded');
  });
});
