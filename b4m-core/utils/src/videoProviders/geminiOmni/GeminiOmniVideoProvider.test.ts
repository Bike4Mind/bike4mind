import { existsSync, readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ValidatedVideoRequest } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { describeVideoProviderConformance, type ConformanceScenario } from '../conformance';
import { ProviderOutputUnavailableError, ProviderSubmitError } from '../types';
import { GeminiOmniVideoProvider } from './GeminiOmniVideoProvider';

type Exchange = {
  name: string;
  request: { method: string; path: string; body?: unknown };
  response: { status: number; headers: Record<string, string>; body?: unknown };
};
type Fixture = { scenario: string; synthetic?: boolean; exchanges: Exchange[] };

const BASE = 'https://generativelanguage.googleapis.com';
const INTERACTIONS = `${BASE}/v1beta/interactions`;
const DOWNLOAD_PATH = /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/[^/]+:download$/;
const KEY = 'test-key';
const VIDEO_BYTES = Buffer.from('fake-mp4-bytes');

// A recording (`<name>.json`) wins over the hand-built stand-in (`<name>.synthetic.json`), so dropping in
// recorded fixtures needs no test edits.
const load = (name: string): Fixture => {
  const recorded = new URL(`./__fixtures__/${name}.json`, import.meta.url);
  const synthetic = new URL(`./__fixtures__/${name}.synthetic.json`, import.meta.url);
  const file = existsSync(recorded) ? recorded : synthetic;
  return JSON.parse(readFileSync(file, 'utf8')) as Fixture;
};
const FIXTURES: Record<ConformanceScenario | 'image' | 'cancel', Fixture> = {
  succeeds: load('text-to-video'),
  image: load('image-to-video'),
  blocked: load('blocked'),
  fails: load('failed'),
  rejects: load('invalid-param'),
  cancel: load('cancel'),
};
const exchange = (fixture: Fixture, name: string): Exchange => {
  const found = fixture.exchanges.find(e => e.name === name);
  if (!found) throw new Error(`${fixture.scenario} has no ${name} exchange`);
  return found;
};

// Replays one fixture: submit, then poll_first until settle() flips to poll_terminal.
let active: Fixture = FIXTURES.succeeds;
let settled = false;
const seenKeys: Array<string | null> = [];
const reply = (e: Exchange) =>
  HttpResponse.json(e.response.body as Record<string, unknown>, { status: e.response.status });

const server = setupServer(
  http.post(INTERACTIONS, ({ request }) => {
    seenKeys.push(request.headers.get('x-goog-api-key'));
    return reply(exchange(active, 'submit'));
  }),
  http.get(`${INTERACTIONS}/:id`, ({ request }) => {
    seenKeys.push(request.headers.get('x-goog-api-key'));
    return reply(exchange(active, settled ? 'poll_terminal' : 'poll_first'));
  }),
  http.post(`${INTERACTIONS}/:id/cancel`, ({ request }) => {
    seenKeys.push(request.headers.get('x-goog-api-key'));
    return reply(exchange(FIXTURES.cancel, 'cancel'));
  }),
  // The test serves small bytes instead of a real clip.
  http.get(DOWNLOAD_PATH, ({ request }) => {
    seenKeys.push(request.headers.get('x-goog-api-key'));
    return new HttpResponse(VIDEO_BYTES, { headers: { 'content-type': 'video/mp4' } });
  })
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
// Per-test server.use() overrides must not leak into the next test (the order-dependent failure mode).
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const request = (overrides: Partial<ValidatedVideoRequest> = {}) =>
  ({
    model: 'gemini-omni-1.1-flash',
    mode: 'text_to_video',
    prompt: 'a lighthouse',
    durationSeconds: 6,
    aspectRatio: '16:9',
    resolution: '720p',
    ...overrides,
  }) as ValidatedVideoRequest;
const ctx = () => ({
  apiKey: KEY,
  logger: new Logger({ metadata: { suite: 'GeminiOmni' } }),
  now: () => new Date('2026-10-06T00:00:00Z'),
  signal: new AbortController().signal,
});
const handleFor = (interactionId: string) => ({ provider: 'gemini-omni' as const, data: { interactionId } });

describeVideoProviderConformance('GeminiOmniVideoProvider', {
  provider: () => new GeminiOmniVideoProvider(),
  context: { apiKey: KEY },
  beforeEach: () => {
    settled = false;
    seenKeys.length = 0;
    server.resetHandlers();
  },
  scenario: name => {
    active = FIXTURES[name];
    return request();
  },
  settle: () => {
    settled = true;
  },
});

describe('GeminiOmniVideoProvider specifics', () => {
  beforeEach(() => {
    active = FIXTURES.succeeds;
    settled = false;
    seenKeys.length = 0;
  });

  it('sends exactly the fixture submit body for the matching text-to-video request', async () => {
    let sent: unknown;
    server.use(
      http.post(INTERACTIONS, async ({ request: r }) => {
        sent = await r.json();
        return reply(exchange(FIXTURES.succeeds, 'submit'));
      })
    );
    const recorded = exchange(FIXTURES.succeeds, 'submit').request.body as {
      input: string;
      response_format: { duration: string };
    };
    const handle = await new GeminiOmniVideoProvider().submit(
      request({ prompt: recorded.input, durationSeconds: Number.parseInt(recorded.response_format.duration, 10) }),
      {},
      ctx()
    );
    expect(sent).toEqual(recorded);
    expect(handle).toEqual({ provider: 'gemini-omni', data: { interactionId: expect.any(String) } });
  });

  it('formats the duration as a Duration string and sends the key header', async () => {
    let sent: { response_format?: { duration?: unknown } } = {};
    let key: string | null = null;
    server.use(
      http.post(INTERACTIONS, async ({ request: r }) => {
        key = r.headers.get('x-goog-api-key');
        sent = (await r.json()) as typeof sent;
        return reply(exchange(FIXTURES.succeeds, 'submit'));
      })
    );
    await new GeminiOmniVideoProvider().submit(request({ durationSeconds: 6 }), {}, ctx());
    expect(sent.response_format?.duration).toBe('6s');
    expect(key).toBe(KEY);
  });

  it('sends the image then the prompt for image-to-video', async () => {
    let sent: { input?: unknown } = {};
    server.use(
      http.post(INTERACTIONS, async ({ request: r }) => {
        sent = (await r.json()) as { input?: unknown };
        return reply(exchange(FIXTURES.image, 'submit'));
      })
    );
    await new GeminiOmniVideoProvider().submit(
      request({ mode: 'image_to_video', inputImageFileId: 'f1' }),
      { inputImage: { bytes: Buffer.from('png'), mimeType: 'image/png' } },
      ctx()
    );
    expect(sent.input).toEqual([
      { type: 'image', data: Buffer.from('png').toString('base64'), mime_type: 'image/png' },
      { type: 'text', text: 'a lighthouse' },
    ]);
  });

  it('carries image-to-video through to a succeeded url output', async () => {
    active = FIXTURES.image;
    const provider = new GeminiOmniVideoProvider();
    const handle = await provider.submit(
      request({ mode: 'image_to_video', inputImageFileId: 'f1' }),
      { inputImage: { bytes: Buffer.from('png'), mimeType: 'image/png' } },
      ctx()
    );
    expect(await provider.poll(handle, ctx())).toEqual({ status: 'running' });
    settled = true;
    expect(await provider.poll(handle, ctx())).toMatchObject({ status: 'succeeded', output: { kind: 'url' } });
  });

  it('refuses image-to-video without an image as a definitive submit error', async () => {
    const error = await new GeminiOmniVideoProvider()
      .submit(request({ mode: 'image_to_video', inputImageFileId: 'f1' }), {}, ctx())
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ definitive: true, message: 'gemini_omni_missing_input_image' });
  });

  it('maps the recorded invalid-param 400 to a definitive code-only error with the raw body', async () => {
    active = FIXTURES.rejects;
    const error = await new GeminiOmniVideoProvider().submit(request(), {}, ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderSubmitError);
    expect(error).toMatchObject({ definitive: true, message: 'gemini_omni_http_400' });
    expect((error as ProviderSubmitError).raw).toEqual(exchange(FIXTURES.rejects, 'submit').response.body);
  });

  it('maps a submit-time safety rejection to a blocked poll without another network call', async () => {
    let polls = 0;
    server.use(
      http.post(INTERACTIONS, () =>
        HttpResponse.json(
          {
            error: {
              code: 'invalid_request',
              message: 'Prompt blocked for safety reasons',
              status: 'PROHIBITED_CONTENT',
            },
          },
          { status: 400 }
        )
      ),
      http.get(`${INTERACTIONS}/:id`, () => {
        polls += 1;
        return HttpResponse.json({});
      })
    );
    const provider = new GeminiOmniVideoProvider();
    const handle = await provider.submit(request(), {}, ctx());
    expect(handle.data).toEqual({ blocked: true, reason: 'gemini_omni_safety' });
    expect(await provider.poll(handle, ctx())).toMatchObject({ status: 'blocked', reason: 'gemini_omni_safety' });
    await expect(provider.cancel(handle, ctx())).resolves.toBeUndefined();
    expect(polls).toBe(0);
  });

  it('does not mistake an auth refusal in the front-end array form for a content block', async () => {
    const body = [{ error: { code: 403, message: 'Requests are blocked.', status: 'API_KEY_SERVICE_BLOCKED' } }];
    server.use(http.post(INTERACTIONS, () => HttpResponse.json(body, { status: 403 })));
    const error = await new GeminiOmniVideoProvider().submit(request(), {}, ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderSubmitError);
    expect(error).toMatchObject({ definitive: true, message: 'gemini_omni_http_403', raw: body });
  });

  it('keeps an invalid-param 400 that names safety_settings a definitive request error', async () => {
    const body = {
      error: { message: "Unknown parameter 'safety_settings'.", code: 'invalid_request', status: 'INVALID_ARGUMENT' },
    };
    server.use(http.post(INTERACTIONS, () => HttpResponse.json(body, { status: 400 })));
    const error = await new GeminiOmniVideoProvider().submit(request(), {}, ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderSubmitError);
    expect(error).toMatchObject({ definitive: true, message: 'gemini_omni_http_400', raw: body });
  });

  it('reads a safety block from the front-end array error form too', async () => {
    server.use(
      http.post(INTERACTIONS, () =>
        HttpResponse.json([{ error: { code: 400, message: 'Blocked', status: 'SAFETY' } }], { status: 400 })
      )
    );
    const handle = await new GeminiOmniVideoProvider().submit(request(), {}, ctx());
    expect(handle.data).toEqual({ blocked: true, reason: 'gemini_omni_safety' });
  });

  it.each([
    [429, true],
    [403, true],
    [500, false],
    [503, false],
  ])('maps a %i submit to definitive=%s with a code-only message', async (status, definitive) => {
    server.use(
      http.post(INTERACTIONS, () => HttpResponse.json({ error: { message: 'raw provider text' } }, { status }))
    );
    const error = await new GeminiOmniVideoProvider().submit(request(), {}, ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderSubmitError);
    expect(error).toMatchObject({ definitive, message: `gemini_omni_http_${status}` });
    expect((error as ProviderSubmitError).raw).toEqual({ error: { message: 'raw provider text' } });
  });

  it('treats a network failure on submit as not definitive', async () => {
    server.use(http.post(INTERACTIONS, () => HttpResponse.error()));
    const error = await new GeminiOmniVideoProvider().submit(request(), {}, ctx()).catch((e: unknown) => e);
    expect(error).toMatchObject({ definitive: false, message: 'gemini_omni_submit_transport' });
  });

  it('treats an unparseable 200 submit as not definitive', async () => {
    server.use(http.post(INTERACTIONS, () => HttpResponse.json({ status: 'in_progress' })));
    const error = await new GeminiOmniVideoProvider().submit(request(), {}, ctx()).catch((e: unknown) => e);
    expect(error).toMatchObject({ definitive: false, message: 'gemini_omni_submit_unparseable' });
  });

  it('polls with the key and reads the fixture failure as non-retryable, keeping provider text in raw', async () => {
    active = FIXTURES.fails;
    settled = true;
    const result = await new GeminiOmniVideoProvider().poll(handleFor('i1'), ctx());
    expect(result).toMatchObject({ status: 'failed', retryable: false, message: 'gemini_omni_failed' });
    expect(result.status === 'failed' && result.raw).toEqual(exchange(FIXTURES.fails, 'poll_terminal').response.body);
    expect(seenKeys).toEqual([KEY]);
  });

  it('reads the fixture safety outcome (completed, no video) as blocked', async () => {
    active = FIXTURES.blocked;
    settled = true;
    expect(await new GeminiOmniVideoProvider().poll(handleFor('i1'), ctx())).toMatchObject({
      status: 'blocked',
      reason: 'gemini_omni_no_video',
    });
  });

  it('reads a failed interaction carrying a safety marker as blocked', async () => {
    server.use(
      http.get(`${INTERACTIONS}/:id`, () =>
        HttpResponse.json({ id: 'i1', status: 'failed', error: { code: 'internal', status: 'PROHIBITED_CONTENT' } })
      )
    );
    expect(await new GeminiOmniVideoProvider().poll(handleFor('i1'), ctx())).toMatchObject({
      status: 'blocked',
      reason: 'gemini_omni_safety',
    });
  });

  it.each([400, 404])('a %i poll (unknown interaction) is a non-retryable failure', async status => {
    server.use(
      http.get(`${INTERACTIONS}/:id`, () =>
        HttpResponse.json(
          { error: { message: 'Invalid interaction name: interactions/gone', code: 'invalid_request' } },
          { status }
        )
      )
    );
    expect(await new GeminiOmniVideoProvider().poll(handleFor('gone'), ctx())).toMatchObject({
      status: 'failed',
      retryable: false,
      message: 'gemini_omni_interaction_not_found',
    });
  });

  it('throws on any other poll 400 (the live auth bug) and logs it at error level without headers', async () => {
    const body = {
      error: {
        message: 'Multiple authentication credentials received. Please pass only one.',
        code: 'invalid_request',
      },
    };
    server.use(http.get(`${INTERACTIONS}/:id`, () => HttpResponse.json(body, { status: 400 })));
    const c = ctx();
    const error = vi.spyOn(c.logger, 'error').mockImplementation(() => undefined);
    await expect(new GeminiOmniVideoProvider().poll(handleFor('i1'), c)).rejects.toThrow('gemini_omni_poll_http_400');
    expect(error).toHaveBeenCalledWith('gemini_omni_poll_rejected', { status: 400, raw: body });
    expect(JSON.stringify(error.mock.calls)).not.toContain(KEY);
  });

  it('fails a completed interaction whose usage reports video tokens but no video is found', async () => {
    const interaction = {
      id: 'i1',
      status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'video_v2', url: 'https://example.invalid/x' }] }],
      usage: { output_tokens_by_modality: [{ modality: 'video', tokens: 17376 }] },
    };
    server.use(http.get(`${INTERACTIONS}/:id`, () => HttpResponse.json(interaction)));
    const c = ctx();
    const error = vi.spyOn(c.logger, 'error').mockImplementation(() => undefined);
    expect(await new GeminiOmniVideoProvider().poll(handleFor('i1'), c)).toMatchObject({
      status: 'failed',
      retryable: false,
      message: 'gemini_omni_video_unparsed',
    });
    expect(error).toHaveBeenCalledWith('gemini_omni_video_unparsed', { interactionId: 'i1' });
  });

  it('a 5xx poll throws so the engine retries', async () => {
    server.use(http.get(`${INTERACTIONS}/:id`, () => HttpResponse.json({}, { status: 502 })));
    await expect(new GeminiOmniVideoProvider().poll(handleFor('i1'), ctx())).rejects.toThrow(
      'gemini_omni_poll_http_502'
    );
  });

  it.each([
    ['budget_exceeded', false],
    ['requires_action', false],
    ['cancelled', false],
    ['incomplete', false],
  ])('maps status %s to failed with retryable=%s', async (status, retryable) => {
    server.use(http.get(`${INTERACTIONS}/:id`, () => HttpResponse.json({ id: 'i1', status })));
    const result = await new GeminiOmniVideoProvider().poll(handleFor('i1'), ctx());
    expect(result).toMatchObject({ status: 'failed', retryable, message: `gemini_omni_${status}` });
  });

  it('maps an unrecognised failure-like status to a non-retryable failure', async () => {
    server.use(http.get(`${INTERACTIONS}/:id`, () => HttpResponse.json({ id: 'i1', status: 'expired' })));
    expect(await new GeminiOmniVideoProvider().poll(handleFor('i1'), ctx())).toMatchObject({
      status: 'failed',
      retryable: false,
      message: 'gemini_omni_unrecognised_failure',
    });
  });

  it('keeps polling through an unknown non-failure status and logs it', async () => {
    server.use(http.get(`${INTERACTIONS}/:id`, () => HttpResponse.json({ id: 'i1', status: 'paused' })));
    const c = ctx();
    const warn = vi.spyOn(c.logger, 'warn').mockImplementation(() => undefined);
    expect(await new GeminiOmniVideoProvider().poll(handleFor('i1'), c)).toEqual({ status: 'running' });
    expect(warn).toHaveBeenCalledWith('gemini_omni_unknown_status', { status: 'paused' });
  });

  it('reports a url output that requires auth', async () => {
    settled = true;
    const result = await new GeminiOmniVideoProvider().poll(handleFor('i1'), ctx());
    expect(result).toMatchObject({
      status: 'succeeded',
      output: { kind: 'url', requiresAuth: true, contentType: expect.stringMatching(/^video\//) },
    });
  });

  it('fetchOutput downloads with the key and restores alt=media dropped by the fixture scrubber', async () => {
    let seen: URL | undefined;
    server.use(
      http.get(DOWNLOAD_PATH, ({ request: r }) => {
        seen = new URL(r.url);
        seenKeys.push(r.headers.get('x-goog-api-key'));
        return new HttpResponse(VIDEO_BYTES, { headers: { 'content-type': 'video/mp4' } });
      })
    );
    settled = true;
    const provider = new GeminiOmniVideoProvider();
    const result = await provider.poll(handleFor('i1'), ctx());
    if (result.status !== 'succeeded') throw new Error(`expected succeeded, got ${result.status}`);
    const bytes = await provider.fetchOutput(result.output, ctx());
    expect(bytes.equals(VIDEO_BYTES)).toBe(true);
    expect(seen?.searchParams.get('alt')).toBe('media');
    expect(seenKeys).toEqual([KEY, KEY]);
  });

  it('fetchOutput keeps an existing alt query untouched', async () => {
    let search = '';
    server.use(
      http.get(DOWNLOAD_PATH, ({ request: r }) => {
        search = new URL(r.url).search;
        return new HttpResponse(VIDEO_BYTES);
      })
    );
    await new GeminiOmniVideoProvider().fetchOutput(
      { kind: 'url', url: `${BASE}/v1beta/files/abc:download?alt=media`, requiresAuth: true },
      ctx()
    );
    expect(search).toBe('?alt=media');
  });

  it('fetchOutput sends the key only to the Gemini host and drops it on a redirect', async () => {
    const keys: Array<string | null> = [];
    server.use(
      http.get(DOWNLOAD_PATH, ({ request: r }) => {
        keys.push(r.headers.get('x-goog-api-key'));
        return new HttpResponse(null, { status: 302, headers: { location: 'https://storage.example.com/clip.mp4' } });
      }),
      http.get('https://storage.example.com/clip.mp4', ({ request: r }) => {
        keys.push(r.headers.get('x-goog-api-key'));
        return new HttpResponse(VIDEO_BYTES, { headers: { 'content-type': 'video/mp4' } });
      })
    );
    const bytes = await new GeminiOmniVideoProvider().fetchOutput(
      { kind: 'url', url: `${BASE}/v1beta/files/abc:download`, requiresAuth: true, contentType: 'video/mp4' },
      ctx()
    );
    expect(bytes.equals(VIDEO_BYTES)).toBe(true);
    expect(keys).toEqual([KEY, null]);
  });

  it.each([
    ['a non-https url', 'http://generativelanguage.googleapis.com/x'],
    ['a foreign host', 'https://storage.example.com/clip.mp4'],
  ])('fetchOutput refuses %s without sending the key', async (_label, url) => {
    let reached = false;
    server.use(
      http.get('https://storage.example.com/clip.mp4', () => {
        reached = true;
        return new HttpResponse(VIDEO_BYTES);
      })
    );
    await expect(
      new GeminiOmniVideoProvider().fetchOutput({ kind: 'url', url, requiresAuth: true }, ctx())
    ).rejects.toThrow('gemini_omni_untrusted_output_url');
    expect(reached).toBe(false);
  });

  it.each([404, 410])('fetchOutput throws ProviderOutputUnavailableError on %i', async status => {
    server.use(http.get(DOWNLOAD_PATH, () => new HttpResponse(null, { status })));
    const error = await new GeminiOmniVideoProvider()
      .fetchOutput({ kind: 'url', url: `${BASE}/v1beta/files/gone:download`, requiresAuth: true }, ctx())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderOutputUnavailableError);
    expect(error).toMatchObject({ status });
  });

  it('cancel posts to the interaction cancel path with the key', async () => {
    let path = '';
    server.use(
      http.post(`${INTERACTIONS}/:id/cancel`, ({ request: r }) => {
        path = new URL(r.url).pathname;
        seenKeys.push(r.headers.get('x-goog-api-key'));
        return reply(exchange(FIXTURES.cancel, 'cancel'));
      })
    );
    await new GeminiOmniVideoProvider().cancel(handleFor('v1_abc'), ctx());
    expect(path).toBe('/v1beta/interactions/v1_abc/cancel');
    expect(seenKeys).toEqual([KEY]);
  });

  it('cancel logs a refusal (status only, never headers) instead of throwing', async () => {
    const body = { error: { message: 'Interaction is already completed.', code: 'invalid_request' } };
    server.use(http.post(`${INTERACTIONS}/:id/cancel`, () => HttpResponse.json(body, { status: 400 })));
    const c = ctx();
    const warn = vi.spyOn(c.logger, 'warn').mockImplementation(() => undefined);
    await expect(new GeminiOmniVideoProvider().cancel(handleFor('i1'), c)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('gemini_omni_cancel_refused', { status: 400, raw: body });
  });
});
