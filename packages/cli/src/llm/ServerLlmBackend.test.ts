import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough, Readable } from 'stream';
import { ServerLlmBackend } from './ServerLlmBackend';
import type { ApiClient } from '../auth/ApiClient';
import type { CompletionRequest } from './streamTransport';
import type { StreamEvent } from './streamEvents';

const sseResponse = (stream: PassThrough) =>
  new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    headers: { 'content-type': 'text/event-stream' },
  });

/** An ApiClient stand-in whose fetch answers every request with `respond`. */
const apiClientFor = (respond: (url: string) => Response) =>
  ({ baseURL: 'http://localhost:3000', fetch: async (url: string) => respond(url) }) as unknown as ApiClient;

/**
 * Adapter-level tests for the SSE transport seam: `open()` must turn the SDK's
 * completions stream into a pull-based iterable of decoded events, ending on
 * `[DONE]` and throwing a server `error` event. The accumulate/retry/finalize
 * policy is covered once in runCompletion.test.ts.
 */
describe('ServerLlmBackend SSE transport (open)', () => {
  const req: CompletionRequest = { model: 'test-model', messages: [], options: {} };

  const backendWith = (stream: PassThrough): ServerLlmBackend =>
    new ServerLlmBackend({
      apiClient: apiClientFor(() => sseResponse(stream)),
      model: 'test-model',
      sseCompletionsUrl: '/completions',
    });

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

  it('maps a pre-stream HTTP failure, keeping the wording handoff.ts matches on', async () => {
    const backend = new ServerLlmBackend({
      apiClient: apiClientFor(() => new Response(JSON.stringify({ error: 'upstream down' }), { status: 503 })),
      model: 'test-model',
    });
    await expect(collect(backend)).rejects.toThrow('Request failed with status 503: upstream down');
  });

  it('extracts the title of an HTML 403 block page', async () => {
    const page = '<!DOCTYPE html><html><head><title>Request blocked</title></head><body></body></html>';
    const backend = new ServerLlmBackend({
      apiClient: apiClientFor(() => new Response(page, { status: 403, headers: { 'content-type': 'text/html' } })),
      model: 'test-model',
    });
    await expect(collect(backend)).rejects.toThrow('403 Forbidden: Request blocked');
  });

  it('ends quietly when aborted mid-stream', async () => {
    const stream = new PassThrough();
    const controller = new AbortController();
    const events: StreamEvent[] = [];
    const done = (async () => {
      for await (const event of backendWith(stream).open(req, controller.signal)) {
        events.push(event);
        controller.abort();
      }
    })();
    stream.write(`data: ${JSON.stringify({ type: 'content', text: 'Hello' })}\n\n`);
    await expect(done).resolves.toBeUndefined();
    expect(events).toEqual([{ type: 'content', text: 'Hello' }]);
  });
});

describe('ServerLlmBackend completions endpoint resolution', () => {
  afterEach(() => {
    delete process.env.B4M_COMPLETIONS_URL;
  });

  /** Build a backend and return the URL its first request POSTs to. */
  const endpointUsed = async (sseCompletionsUrl?: string): Promise<string> => {
    let posted = '';
    const stream = new PassThrough();
    stream.end('data: [DONE]\n\n');
    const apiClient = apiClientFor(url => {
      posted = url;
      return sseResponse(stream);
    });
    const backend = new ServerLlmBackend({ apiClient, model: 'test-model', sseCompletionsUrl });
    // Drain the (already-ended) stream so open() issues the POST.
    const drained = backend.open({ model: 'test-model', messages: [], options: {} });
    while (!(await drained[Symbol.asyncIterator]().next()).done) {
      /* no-op */
    }
    return posted;
  };

  it('prefers the server-advertised sseCompletionsUrl', async () => {
    process.env.B4M_COMPLETIONS_URL = 'http://localhost:8788/api/ai/v1/completions';
    expect(await endpointUsed('https://advertised.example/completions')).toBe('https://advertised.example/completions');
  });

  it('falls back to B4M_COMPLETIONS_URL when the server advertises none', async () => {
    process.env.B4M_COMPLETIONS_URL = 'http://localhost:8788/api/ai/v1/completions';
    expect(await endpointUsed(undefined)).toBe('http://localhost:8788/api/ai/v1/completions');
  });

  it('defaults to the same-origin path without either', async () => {
    expect(await endpointUsed(undefined)).toBe('http://localhost:3000/api/ai/v1/completions');
  });
});
