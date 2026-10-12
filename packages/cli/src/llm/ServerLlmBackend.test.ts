import { describe, it, expect, afterEach, vi } from 'vitest';
import { PassThrough } from 'stream';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { ServerLlmBackend } from './ServerLlmBackend';
import type { ApiClient } from '../auth/ApiClient';
import type { CompletionRequest } from './streamTransport';
import type { StreamEvent } from './streamEvents';
import { isLlmUnavailableError } from '../utils/handoff';

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
    return new ServerLlmBackend({ apiClient, model: 'test-model', sseCompletionsUrl: '/completions' });
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
  const endpointUsed = async (sseCompletionsUrl?: string): Promise<string> => {
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
    expect(await endpointUsed(undefined)).toBe('/api/ai/v1/completions');
  });
});

describe('ServerLlmBackend pre-stream HTTP errors', () => {
  const req: CompletionRequest = { model: 'test-model', messages: [], options: {} };

  /** A backend whose POST fails the way axios does with responseType 'stream': the body is unread. */
  const backendFailingWithData = (status: number, data: unknown): ServerLlmBackend => {
    const apiClient = {
      getAxiosInstance: () => ({
        post: async () => {
          throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', undefined, {}, {
            status,
            statusText: 'Error',
            data,
            headers: {},
            config: {} as InternalAxiosRequestConfig,
          } as AxiosResponse);
        },
      }),
    } as unknown as ApiClient;
    return new ServerLlmBackend({ apiClient, model: 'test-model', sseCompletionsUrl: '/completions' });
  };

  const backendFailingWith = (status: number, body: string): ServerLlmBackend => {
    const data = new PassThrough();
    data.end(body);
    return backendFailingWithData(status, data);
  };

  const firstEvent = (backend: ServerLlmBackend) => backend.open(req)[Symbol.asyncIterator]().next();

  it('surfaces the JSON error and errorCode of a 422', async () => {
    const body = JSON.stringify({
      error: 'Insufficient credits.',
      errorCode: 'insufficient_credits',
      request_id: 'r1',
    });
    const error = await firstEvent(backendFailingWith(422, body)).catch((e: unknown) => e);
    expect((error as Error).message).toBe('Insufficient credits. (insufficient_credits)');
  });

  it('keeps the "Rate limit exceeded" prefix callers match on for a 429', async () => {
    const message = 'Rate limit exceeded: 10 requests per minute. Try again in 12 seconds.';
    const error = await firstEvent(backendFailingWith(429, JSON.stringify({ error: message, request_id: 'r2' }))).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
    expect(isLlmUnavailableError(error)).toBe(true);
  });

  it('surfaces provider_not_configured on a 503 and still triggers handoff fallback', async () => {
    const body = JSON.stringify({
      error: 'Failed to create LLM backend for model: x',
      errorCode: 'provider_not_configured',
    });
    const error = await firstEvent(backendFailingWith(503, body)).catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      'Request failed with status 503: Failed to create LLM backend for model: x (provider_not_configured)'
    );
    expect(isLlmUnavailableError(error)).toBe(true);
  });

  it('keeps the 5xx status prefix on a JSON 500 without an errorCode', async () => {
    const error = await firstEvent(backendFailingWith(500, JSON.stringify({ error: 'Boom' }))).catch((e: unknown) => e);
    expect((error as Error).message).toBe('Request failed with status 500: Boom');
    expect(isLlmUnavailableError(error)).toBe(true);
  });

  it('falls back to the status line for a non-JSON body', async () => {
    await expect(firstEvent(backendFailingWith(502, 'Bad Gateway'))).rejects.toThrow(
      'Request failed with status 502: Error'
    );
  });

  it('still names the title of an HTML 403 page', async () => {
    const html = '<!DOCTYPE html><html><head><title>Request blocked</title></head><body></body></html>';
    await expect(firstEvent(backendFailingWith(403, html))).rejects.toThrow('403 Forbidden: Request blocked');
  });

  const messageOf = async (backend: ServerLlmBackend) =>
    ((await firstEvent(backend).catch((e: unknown) => e)) as Error).message;
  const envelope = JSON.stringify({ error: 'Bad input', errorCode: 'invalid_request' });

  it('reads a Buffer body', async () => {
    expect(await messageOf(backendFailingWithData(422, Buffer.from(envelope)))).toBe('Bad input (invalid_request)');
  });

  it('reads a string body', async () => {
    expect(await messageOf(backendFailingWithData(422, envelope))).toBe('Bad input (invalid_request)');
  });

  it('reads an already-parsed object body', async () => {
    expect(await messageOf(backendFailingWithData(422, { error: 'Bad input', errorCode: 'invalid_request' }))).toBe(
      'Bad input (invalid_request)'
    );
  });

  it('falls back to the status line for an empty body', async () => {
    expect(await messageOf(backendFailingWith(400, ''))).toBe('Request failed with status 400: Error');
  });

  it('falls back to the status line for a non-JSON 4xx body', async () => {
    expect(await messageOf(backendFailingWith(404, 'not here'))).toBe('Request failed with status 404: Error');
  });

  it('falls back to the status line when the JSON has no string error field', async () => {
    expect(await messageOf(backendFailingWith(400, JSON.stringify({ error: { nested: true } })))).toBe(
      'Request failed with status 400: Error'
    );
  });

  it('stops reading and destroys an oversize body at the cap', async () => {
    const data = new PassThrough();
    data.end(`{"error":"${'x'.repeat(200_000)}"}`);
    expect(await messageOf(backendFailingWithData(400, data))).toBe('Request failed with status 400: Error');
    expect(data.destroyed).toBe(true);
  });

  it('gives up on a body that never ends and destroys the stream', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const data = new PassThrough();
      data.write('{"error":"partial');
      const pending = messageOf(backendFailingWithData(400, data));
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toBe('Request failed with status 400: Error');
      expect(data.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
