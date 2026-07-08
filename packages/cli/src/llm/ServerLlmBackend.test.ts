import { describe, it, expect } from 'vitest';
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
