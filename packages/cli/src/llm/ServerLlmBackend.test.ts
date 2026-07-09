import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'stream';
import { ServerLlmBackend } from './ServerLlmBackend';
import type { ApiClient } from '../auth/ApiClient';
import type { CompletionRequest } from './streamTransport';
import type { StreamEvent } from './streamEvents';

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

describe('ServerLlmBackend completions endpoint resolution', () => {
  afterEach(() => {
    delete process.env.B4M_COMPLETIONS_URL;
  });

  /** Build a backend and return the URL its first request POSTs to. */
  const endpointUsed = async (completionsUrl?: string): Promise<string> => {
    let posted = '';
    const stream = new PassThrough();
    stream.end('data: [DONE]\n\n');
    const apiClient = {
      getAxiosInstance: () => ({
        post: async (url: string) => {
          posted = url;
          return { status: 200, statusText: 'OK', data: stream };
        },
      }),
    } as unknown as ApiClient;
    const backend = new ServerLlmBackend({ apiClient, model: 'test-model', completionsUrl });
    // Drain the (already-ended) stream so open() issues the POST.
    const drained = backend.open({ model: 'test-model', messages: [], options: {} });
    while (!(await drained[Symbol.asyncIterator]().next()).done) {
      /* no-op */
    }
    return posted;
  };

  it('prefers the server-advertised completionsUrl', async () => {
    process.env.B4M_COMPLETIONS_URL = 'http://localhost:8788/api/ai/v1/completions';
    expect(await endpointUsed('https://advertised.example/completions')).toBe('https://advertised.example/completions');
  });

  it('falls back to B4M_COMPLETIONS_URL when the server advertises none', async () => {
    process.env.B4M_COMPLETIONS_URL = 'http://localhost:8788/api/ai/v1/completions';
    expect(await endpointUsed(undefined)).toBe('http://localhost:8788/api/ai/v1/completions');
  });

  it('defaults to the same-origin path without either', async () => {
    expect(await endpointUsed(undefined)).toBe('/api/ai/v1/completions');
  });
});
