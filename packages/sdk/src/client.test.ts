import { afterEach, describe, expect, it, vi } from 'vitest';
import pkg from '../package.json';
import { createClient } from './client';
import { B4mApiError, B4mQuestError } from './errors';

const BASE = 'https://b4m.example.com/';

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
  });
}

function setup(...responses: Array<Response | (() => Response)>) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) {
    fetch.mockImplementationOnce(async () => (typeof response === 'function' ? response() : response));
  }
  const client = createClient({ baseUrl: BASE, apiKey: 'b4m_live_key', fetch });
  const request = (i = 0) => {
    const [url, init] = fetch.mock.calls[i];
    return { url: String(url), init: init as RequestInit, headers: new Headers(init?.headers) };
  };
  return { client, fetch, request };
}

const quest = (fields: Record<string, unknown>) => ({
  id: 'q1',
  sessionId: 's1',
  images: [],
  videos: [],
  files: [],
  toolPayloads: [],
  ...fields,
});

afterEach(() => vi.useRealTimers());

describe('auth', () => {
  it('sends the api key as a Bearer token', async () => {
    const { client, request } = setup(json({}));
    await client.call('getMe');
    expect(request().headers.get('authorization')).toBe('Bearer b4m_live_key');
  });

  it('prefers getAuthToken, asked per request, and falls back to apiKey when it returns nothing', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({}));
    const tokens = ['jwt-1', undefined];
    const client = createClient({ baseUrl: BASE, apiKey: 'k', fetch, getAuthToken: async () => tokens.shift() });
    await client.call('getMe');
    await client.call('getMe');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer jwt-1');
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get('authorization')).toBe('Bearer k');
  });

  it('keeps a caller Authorization header when no token is configured', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({}));
    const client = createClient({ baseUrl: BASE, fetch, headers: { Authorization: 'ApiKey x' } });
    await client.call('getMe');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('ApiKey x');
  });

  it('requires a baseUrl', () => {
    expect(() => createClient({ baseUrl: '' })).toThrow(/baseUrl/);
  });
});

describe('call', () => {
  it('GET: joins baseUrl and serializes the query, skipping undefined', async () => {
    const { client, request } = setup(json({ data: [], next_cursor: null }));
    const result = await client.call('listModels', { query: { limit: 5, cursor: undefined } });
    expect(request().url).toBe('https://b4m.example.com/api/v1/models?limit=5');
    expect(request().init.method).toBe('GET');
    expect(result).toEqual({ data: [], next_cursor: null });
  });

  it('POST: sends a JSON body', async () => {
    const { client, request } = setup(json({ id: 'p1' }, { status: 201 }));
    await client.call('createProject', { body: { name: 'Plans' } as never });
    expect(request().init.method).toBe('POST');
    expect(request().headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(request().init.body))).toEqual({ name: 'Plans' });
  });

  it('encodes path params', async () => {
    const { client, request } = setup(json({}));
    await client.call('getDataLakeFile', { params: { id: 'a/b', file_id: 'c d' } });
    expect(request().url).toBe('https://b4m.example.com/api/v1/data-lakes/a%2Fb/files/c%20d');
  });

  it('refuses an empty or dot-segment path param before sending', async () => {
    const { client, fetch } = setup();
    await expect(client.call('deleteSession', { params: { id: '' } })).rejects.toThrow(/Invalid path parameter id/);
    await expect(client.call('deleteSession', { params: { id: '..' } })).rejects.toThrow(/Invalid path parameter/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('passes redirect through to fetch', async () => {
    const { client, request } = setup(json({ newLastNotebookId: null }));
    await client.call('deleteSession', { params: { id: 'n1' }, redirect: 'manual' });
    expect(request().init.redirect).toBe('manual');
  });

  it('throws on a non-JSON 2xx body', async () => {
    const { client } = setup(new Response('ID3', { headers: { 'content-type': 'audio/mpeg' } }));
    await expect(client.call('synthesizeSpeech', { body: {} as never })).rejects.toThrow(
      'synthesizeSpeech returned audio/mpeg; use raw() or the tts/music/soundEffects helpers'
    );
  });

  it('returns undefined for a 204', async () => {
    const { client } = setup(new Response(null, { status: 204 }));
    expect(await client.call('deleteProject', { params: { id: 'p1' } })).toBeUndefined();
  });
});

describe('B4mApiError', () => {
  it('maps the error envelope and Retry-After', async () => {
    const { client } = setup(
      json(
        { error: 'Slow down', errorCode: 'rate_limited', request_id: 'req-body', name: 'Deprecated' },
        { status: 429, headers: { 'retry-after': '7', 'x-request-id': 'req-header' } }
      )
    );
    const error = await client.call('getMe').catch(e => e);
    expect(error).toBeInstanceOf(B4mApiError);
    expect(error).toMatchObject({
      status: 429,
      message: 'Slow down',
      errorCode: 'rate_limited',
      requestId: 'req-body',
      retryAfterSeconds: 7,
    });
  });

  it('falls back to X-Request-ID and keeps a non-JSON body as text', async () => {
    const { client } = setup(
      new Response('<html>bad gateway</html>', { status: 502, headers: { 'x-request-id': 'r2' } })
    );
    const error = await client.call('getMe').catch(e => e);
    expect(error).toMatchObject({
      status: 502,
      message: 'HTTP 502',
      requestId: 'r2',
      body: '<html>bad gateway</html>',
    });
    expect(error.errorCode).toBeUndefined();
    expect(error.retryAfterSeconds).toBeUndefined();
  });

  it('parses an HTTP-date Retry-After', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-01-01T00:00:00Z') });
    const { client } = setup(
      json({ error: 'x' }, { status: 429, headers: { 'retry-after': 'Thu, 01 Jan 2026 00:00:30 GMT' } })
    );
    expect(await client.call('getMe').catch(e => e.retryAfterSeconds)).toBe(30);
  });
});

describe('completions', () => {
  it('yields parsed events, skips unparseable ones, and stops at [DONE]', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"meta","requestId":"r"}\n\ndata: {"type":"con'));
        controller.enqueue(encoder.encode('tent","text":"hi"}\n\ndata: not json\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"error","message":"boom"}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    });
    const { client, request } = setup(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    const events = [];
    for await (const event of client.completions({ model: 'm', messages: [] } as never)) events.push(event);
    expect(events).toEqual([
      { type: 'meta', requestId: 'r' },
      { type: 'content', text: 'hi' },
      { type: 'error', message: 'boom' },
    ]);
    expect(request().url).toBe('https://b4m.example.com/api/ai/v1/completions');
    expect(request().headers.get('accept')).toBe('text/event-stream');
  });

  it('uses an absolute url override as-is', async () => {
    const { client, request } = setup(new Response('data: [DONE]\n\n'));
    for await (const event of client.completions({} as never, { url: 'https://stream.example.com/sse' })) void event;
    expect(request().url).toBe('https://stream.example.com/sse');
  });

  it('throws after yielding when the stream ends without [DONE]', async () => {
    const { client } = setup(new Response('data: {"type":"content","text":"hi"}\n\n'));
    const events: unknown[] = [];
    const iterate = async () => {
      for await (const event of client.completions({} as never)) events.push(event);
    };
    await expect(iterate()).rejects.toThrow('completion stream ended before [DONE]');
    expect(events).toEqual([{ type: 'content', text: 'hi' }]);
  });

  it('yields an error frame then EOF without throwing', async () => {
    const { client } = setup(new Response('data: {"type":"error","message":"boom"}\n\n'));
    const events: unknown[] = [];
    for await (const event of client.completions({} as never)) events.push(event);
    expect(events).toEqual([{ type: 'error', message: 'boom' }]);
  });

  it('throws B4mApiError for a pre-stream failure', async () => {
    const { client } = setup(json({ error: 'no key', errorCode: 'provider_not_configured' }, { status: 401 }));
    const iterate = async () => {
      for await (const event of client.completions({} as never)) void event;
    };
    await expect(iterate()).rejects.toMatchObject({ status: 401, errorCode: 'provider_not_configured' });
  });
});

describe('quest polling', () => {
  it('chat: polls getQuest until done and returns the finished quest', async () => {
    const { client, request } = setup(
      json({ id: 'q1', status: 'queued', message_received: true, timestamp: 't', model: 'm', tracking_info: {} }),
      json(quest({ status: 'running' })),
      json(quest({ status: 'done', type: 'message', reply: 'hello' }))
    );
    const handle = await client.chat({ message: 'hi' } as never);
    expect(handle.questId).toBe('q1');
    const result = await handle.poll({ intervalMs: 1 });
    expect(result.reply).toBe('hello');
    expect(request(1).url).toBe('https://b4m.example.com/api/v1/quests/q1');
  });

  it('generateImage: takes the quest id from ack.quest', async () => {
    const { client } = setup(
      json({ quest: { id: 'img-q', sessionId: 's' } }),
      json(quest({ id: 'img-q', status: 'done', images: ['a.png'] }))
    );
    const handle = await client.generateImage({ prompt: 'p', model: 'm' } as never);
    expect(handle.questId).toBe('img-q');
    expect((await handle.poll({ intervalMs: 1 })).images).toEqual(['a.png']);
  });

  it('throws on a done quest with type error', async () => {
    const { client } = setup(
      json(quest({ status: 'done', type: 'error', reply: 'out of credits', errorCode: 'insufficient_credits' }))
    );
    const error = await client.pollQuest('q1').catch(e => e);
    expect(error).toBeInstanceOf(B4mQuestError);
    expect(error).toMatchObject({ reason: 'error', message: 'out of credits' });
    expect(error.quest.errorCode).toBe('insufficient_credits');
  });

  it('throws on type error while status is still running', async () => {
    const { client } = setup(json(quest({ status: 'running', type: 'error', reply: 'dispatch failed' })));
    await expect(client.pollQuest('q1')).rejects.toMatchObject({ reason: 'error', message: 'dispatch failed' });
  });

  it('throws on a stopped quest even without type error', async () => {
    const { client } = setup(json(quest({ status: 'stopped', type: 'message', reply: 'cancelled' })));
    await expect(client.pollQuest('q1')).rejects.toMatchObject({ reason: 'stopped' });
  });

  it('times out with the last seen quest', async () => {
    const { client } = setup(() => json(quest({ status: 'running' })));
    await expect(client.pollQuest('q1', { intervalMs: 50, timeoutMs: 10 })).rejects.toMatchObject({
      reason: 'timeout',
      quest: { status: 'running' },
    });
  });

  it('stops waiting when aborted between polls', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(quest({ status: 'running' })));
    const client = createClient({ baseUrl: BASE, fetch });
    const controller = new AbortController();
    const pending = client.pollQuest('q1', { intervalMs: 60_000, signal: controller.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('audio', () => {
  it('always asks for base64 and returns the JSON body', async () => {
    const body = {
      delivery: 'inline',
      audio: 'AAA=',
      format: 'mp3',
      contentType: 'audio/mpeg',
      saved: true,
      fabFileId: 'f',
    };
    const { client, request } = setup(json(body));
    expect(await client.music({ prompt: 'p' } as never)).toEqual(body);
    expect(request().url).toBe('https://b4m.example.com/api/ai/music');
    expect(JSON.parse(String(request().init.body))).toEqual({ prompt: 'p', encoding: 'base64' });
  });

  it('rebuilds the inline shape from raw bytes and X-B4M-Audio-* headers', async () => {
    const { client } = setup(
      new Response(new Uint8Array([1, 2, 3, 255]), {
        headers: {
          'content-type': 'audio/mpeg',
          'x-b4m-audio-saved': 'true',
          'x-b4m-audio-fab-file-id': 'fab1',
          'x-b4m-audio-file-name': 'clip.mp3',
          'x-b4m-audio-file-url': 'https://cdn.example.com/clip.mp3',
        },
      })
    );
    expect(await client.soundEffects({ text: 'boom' } as never)).toEqual({
      delivery: 'inline',
      audio: 'AQID/w==',
      contentType: 'audio/mpeg',
      saved: true,
      fabFileId: 'fab1',
      fileName: 'clip.mp3',
      fileUrl: 'https://cdn.example.com/clip.mp3',
    });
  });

  it('ignores the file headers when the copy was not saved', async () => {
    const { client } = setup(
      new Response(new Uint8Array([1]), {
        headers: { 'content-type': 'audio/wav', 'x-b4m-audio-saved': 'false', 'x-b4m-audio-fab-file-id': 'stale' },
      })
    );
    const { data } = (await client.tts({ text: 'hi' })) as { data: Record<string, unknown> };
    expect(data).toEqual({ delivery: 'inline', audio: 'AQ==', contentType: 'audio/wav', saved: false });
  });

  it('tts: returns saved-too-large for a 413 that kept a saved copy', async () => {
    const { client } = setup(
      json(
        { error: 'too large', provider: 'elevenlabs', saved: true, fabFileId: 'fab9' },
        { status: 413, headers: { 'x-b4m-tts-provider-fallback-from': 'openai' } }
      )
    );
    expect(await client.tts({ text: 'long' })).toEqual({
      kind: 'saved-too-large',
      data: { error: 'too large', provider: 'elevenlabs', saved: true, fabFileId: 'fab9' },
      fallbackFrom: 'openai',
    });
  });

  it('tts: rethrows a 413 whose body does not match the 413 schema', async () => {
    const { client } = setup(json({ error: 'too large', saved: true, fabFileId: 'fab9' }, { status: 413 }));
    await expect(client.tts({ text: 'long' })).rejects.toMatchObject({ status: 413 });
  });

  it('tts: rethrows a 413 without a saved copy', async () => {
    const { client } = setup(json({ error: 'too large', provider: 'openai' }, { status: 413 }));
    await expect(client.tts({ text: 'long' })).rejects.toMatchObject({ status: 413, message: 'too large' });
  });
});

describe('package', () => {
  // The SDK is published standalone, so it must not pull any workspace package (or anything else) in at runtime.
  it('has exactly one runtime dependency', () => {
    expect(Object.keys(pkg.dependencies)).toEqual(['eventsource-parser']);
  });
});
