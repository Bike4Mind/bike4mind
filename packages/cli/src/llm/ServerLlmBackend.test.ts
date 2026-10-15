import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough, Readable } from 'stream';
import { AxiosError } from 'axios';
import { ServerLlmBackend } from './ServerLlmBackend';
import type { ApiClient } from '../auth/ApiClient';
import type { CompletionRequest } from './streamTransport';
import type { StreamEvent } from './streamEvents';
import { isLlmUnavailableError } from '../utils/handoff';

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

  // Both strings are matched by isLlmUnavailableError (utils/handoff.ts) to decide fallback.
  it.each([
    ['connect ECONNREFUSED 127.0.0.1:3000', 'ECONNREFUSED', 'Cannot connect to Bike4Mind server'],
    ['socket hang up', 'ECONNRESET', 'Failed to complete LLM request: socket hang up'],
  ])(
    'maps a no-response transport failure (%s), keeping the wording handoff.ts matches on',
    async (cause, code, wording) => {
      const backend = new ServerLlmBackend({
        apiClient: {
          baseURL: 'http://localhost:3000',
          fetch: async () => {
            // ApiClient.fetch rethrows a failure with no response as the axios error.
            throw new AxiosError(cause, code);
          },
        } as unknown as ApiClient,
        model: 'test-model',
      });
      await expect(collect(backend)).rejects.toThrow(wording);
    }
  );

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

describe('ServerLlmBackend.getModelInfo', () => {
  const backendListing = (models: unknown[]) =>
    new ServerLlmBackend({
      apiClient: { baseURL: 'http://localhost:3000', get: async () => ({ models }) } as unknown as ApiClient,
      model: 'test-model',
    });

  it('drops disabled models from the CLI picker', async () => {
    const models = await backendListing([
      { id: 'live', type: 'text', supportsTools: true },
      { id: 'disabled', type: 'text', supportsTools: true, disabled: true },
      { id: 'no-tools', type: 'text', supportsTools: false },
    ]).getModelInfo();

    expect(models.map(m => m.id)).toEqual(['live']);
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

describe('ServerLlmBackend pre-stream HTTP errors', () => {
  const messageOf = async (status: number, body: string): Promise<string> => {
    const backend = new ServerLlmBackend({
      apiClient: apiClientFor(() => new Response(body, { status })),
      model: 'test-model',
    });
    const events = backend.open({ model: 'test-model', messages: [], options: {} });
    const error = await events[Symbol.asyncIterator]()
      .next()
      .catch((e: unknown) => e);
    return (error as Error).message;
  };

  it('surfaces the JSON error and errorCode of a 422', async () => {
    const body = JSON.stringify({
      error: 'Insufficient credits.',
      errorCode: 'insufficient_credits',
      request_id: 'r1',
    });
    expect(await messageOf(422, body)).toBe('Insufficient credits. (insufficient_credits)');
  });

  it('keeps the "Rate limit exceeded" prefix callers match on for a 429', async () => {
    const message = 'Rate limit exceeded: 10 requests per minute. Try again in 12 seconds.';
    const got = await messageOf(429, JSON.stringify({ error: message, request_id: 'r2' }));
    expect(got).toBe(message);
    expect(isLlmUnavailableError(new Error(got))).toBe(true);
  });

  it('surfaces provider_not_configured on a 503 and still triggers handoff fallback', async () => {
    const body = JSON.stringify({
      error: 'Failed to create LLM backend for model: x',
      errorCode: 'provider_not_configured',
    });
    const got = await messageOf(503, body);
    expect(got).toBe(
      'Request failed with status 503: Failed to create LLM backend for model: x (provider_not_configured)'
    );
    expect(isLlmUnavailableError(new Error(got))).toBe(true);
  });

  it('falls back to the status line for a non-JSON body', async () => {
    expect(await messageOf(502, 'Bad Gateway')).toBe('Request failed with status 502: HTTP 502');
  });

  it('falls back to the status line when the JSON has no string error field', async () => {
    expect(await messageOf(400, JSON.stringify({ error: { nested: true } }))).toBe(
      'Request failed with status 400: HTTP 400'
    );
  });
});
