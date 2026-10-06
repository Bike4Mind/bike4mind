import { existsSync, readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ValidatedVideoRequest } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { describeVideoProviderConformance, type ConformanceScenario } from '../conformance';
import { ProviderOutputUnavailableError, ProviderSubmitError } from '../types';
import { VeoVideoProvider } from './VeoVideoProvider';

type Exchange = {
  name: string;
  request: { method: string; path: string; body?: unknown };
  response: { status: number; headers: Record<string, string>; body?: unknown };
};
type Fixture = { scenario: string; synthetic?: boolean; exchanges: Exchange[] };

const MODEL = 'veo-3.1-fast-generate-preview';
const BASE = 'https://generativelanguage.googleapis.com';
const SUBMIT = `${BASE}/v1beta/models/${MODEL}:predictLongRunning`;
const OPERATION_PATH = `${BASE}/v1beta/models/${MODEL}/operations/:id`;
const DOWNLOAD_PATH = /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/[^/]+:download$/;
const KEY = 'test-key';
const VIDEO_BYTES = Buffer.from('fake-mp4-bytes');
const OPERATION = `models/${MODEL}/operations/abc123`;

// A recording (`<name>.json`) wins over the hand-built stand-in (`<name>.synthetic.json`), so dropping in
// recorded fixtures needs no test edits.
const load = (name: string): Fixture => {
  const recorded = new URL(`./__fixtures__/${name}.json`, import.meta.url);
  const synthetic = new URL(`./__fixtures__/${name}.synthetic.json`, import.meta.url);
  const file = existsSync(recorded) ? recorded : synthetic;
  return JSON.parse(readFileSync(file, 'utf8')) as Fixture;
};
const FIXTURES: Record<
  ConformanceScenario | 'image' | 'imageRejected' | 'failedInternal' | 'unknownOperation',
  Fixture
> = {
  succeeds: load('text-to-video'),
  image: load('image-to-video'),
  blocked: load('blocked'),
  fails: load('failed'),
  rejects: load('invalid-param'),
  imageRejected: load('image-inline-data-rejected'),
  failedInternal: load('failed-internal'),
  unknownOperation: load('unknown-operation'),
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
  http.post(SUBMIT, ({ request }) => {
    seenKeys.push(request.headers.get('x-goog-api-key'));
    return reply(exchange(active, 'submit'));
  }),
  http.get(OPERATION_PATH, ({ request }) => {
    seenKeys.push(request.headers.get('x-goog-api-key'));
    return reply(exchange(active, settled ? 'poll_terminal' : 'poll_first'));
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
    model: MODEL,
    mode: 'text_to_video',
    prompt: 'a lighthouse',
    durationSeconds: 4,
    aspectRatio: '16:9',
    resolution: '720p',
    ...overrides,
  }) as ValidatedVideoRequest;
const ctx = () => ({
  apiKey: KEY,
  logger: new Logger({ metadata: { suite: 'Veo' } }),
  now: () => new Date('2026-10-06T00:00:00Z'),
  signal: new AbortController().signal,
});
const handleFor = (operationName: string) => ({ provider: 'veo' as const, data: { operationName } });
const pollWith = (body: unknown, status = 200) => {
  server.use(http.get(OPERATION_PATH, () => HttpResponse.json(body as Record<string, unknown>, { status })));
  return new VeoVideoProvider().poll(handleFor(OPERATION), ctx());
};
const doneWith = (generateVideoResponse: unknown) => ({
  name: OPERATION,
  done: true,
  response: { generateVideoResponse },
});

describeVideoProviderConformance('VeoVideoProvider', {
  provider: () => new VeoVideoProvider(),
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

describe('VeoVideoProvider specifics', () => {
  beforeEach(() => {
    active = FIXTURES.succeeds;
    settled = false;
    seenKeys.length = 0;
  });

  it('sends exactly the fixture submit body for the matching text-to-video request', async () => {
    let sent: unknown;
    server.use(
      http.post(SUBMIT, async ({ request: r }) => {
        sent = await r.json();
        return reply(exchange(FIXTURES.succeeds, 'submit'));
      })
    );
    const recorded = exchange(FIXTURES.succeeds, 'submit').request.body as {
      instances: Array<{ prompt: string }>;
      parameters: { durationSeconds: number };
    };
    const handle = await new VeoVideoProvider().submit(
      request({ prompt: recorded.instances[0].prompt, durationSeconds: recorded.parameters.durationSeconds }),
      {},
      ctx()
    );
    expect(sent).toEqual(recorded);
    expect(handle).toEqual({ provider: 'veo', data: { operationName: expect.stringMatching(/^models\//) } });
  });

  it('sends the key header on submit and poll', async () => {
    const provider = new VeoVideoProvider();
    const handle = await provider.submit(request(), {}, ctx());
    await provider.poll(handle, ctx());
    expect(seenKeys).toEqual([KEY, KEY]);
  });

  it('sends exactly the fixture submit body for image-to-video (bytesBase64Encoded, allow_adult)', async () => {
    let sent: unknown;
    server.use(
      http.post(SUBMIT, async ({ request: r }) => {
        sent = await r.json();
        return reply(exchange(FIXTURES.image, 'submit'));
      })
    );
    const recorded = exchange(FIXTURES.image, 'submit').request.body as {
      instances: Array<{ prompt: string; image: { bytesBase64Encoded: string } }>;
    };
    const bytes = Buffer.from('png');
    await new VeoVideoProvider().submit(
      request({ mode: 'image_to_video', inputImageFileId: 'f1', prompt: recorded.instances[0].prompt }),
      { inputImage: { bytes, mimeType: 'image/png' } },
      ctx()
    );
    // The recording redacts the image bytes, so compare with them redacted in the sent body too.
    const redact = (body: unknown) =>
      JSON.parse(
        JSON.stringify(body).replace(bytes.toString('base64'), recorded.instances[0].image.bytesBase64Encoded)
      ) as unknown;
    expect(redact(sent)).toEqual(recorded);
  });

  it('does not send personGeneration for text-to-video', async () => {
    let sent: { parameters?: Record<string, unknown> } = {};
    server.use(
      http.post(SUBMIT, async ({ request: r }) => {
        sent = (await r.json()) as typeof sent;
        return reply(exchange(FIXTURES.succeeds, 'submit'));
      })
    );
    await new VeoVideoProvider().submit(request(), {}, ctx());
    expect(sent.parameters).not.toHaveProperty('personGeneration');
  });

  it('maps the rejected inlineData 400 to a definitive non-retryable error', async () => {
    active = FIXTURES.imageRejected;
    const error = await new VeoVideoProvider()
      .submit(
        request({ mode: 'image_to_video', inputImageFileId: 'f1' }),
        { inputImage: { bytes: Buffer.from('png'), mimeType: 'image/png' } },
        ctx()
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ definitive: true, retryable: false, message: 'veo_http_400' });
  });

  it('carries image-to-video through to a succeeded url output', async () => {
    active = FIXTURES.image;
    const provider = new VeoVideoProvider();
    const handle = await provider.submit(
      request({ mode: 'image_to_video', inputImageFileId: 'f1' }),
      { inputImage: { bytes: Buffer.from('png'), mimeType: 'image/png' } },
      ctx()
    );
    expect(await provider.poll(handle, ctx())).toEqual({ status: 'running' });
    settled = true;
    expect(await provider.poll(handle, ctx())).toMatchObject({
      status: 'succeeded',
      output: { kind: 'url', requiresAuth: true, contentType: 'video/mp4' },
    });
  });

  it('refuses image-to-video without an image as a definitive submit error', async () => {
    const error = await new VeoVideoProvider()
      .submit(request({ mode: 'image_to_video', inputImageFileId: 'f1' }), {}, ctx())
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ definitive: true, retryable: false, message: 'veo_missing_input_image' });
  });

  it('maps the invalid-param 400 to a definitive non-retryable error with the raw body', async () => {
    active = FIXTURES.rejects;
    const error = await new VeoVideoProvider().submit(request(), {}, ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderSubmitError);
    expect(error).toMatchObject({ definitive: true, retryable: false, message: 'veo_http_400' });
    expect((error as ProviderSubmitError).raw).toEqual(exchange(FIXTURES.rejects, 'submit').response.body);
  });

  it('maps a submit-time safety rejection to a blocked poll without another network call', async () => {
    let polls = 0;
    server.use(
      http.post(SUBMIT, () =>
        HttpResponse.json(
          { error: { code: 400, message: 'Prompt blocked for safety reasons', status: 'INVALID_ARGUMENT' } },
          { status: 400 }
        )
      ),
      http.get(OPERATION_PATH, () => {
        polls += 1;
        return HttpResponse.json({});
      })
    );
    const provider = new VeoVideoProvider();
    const handle = await provider.submit(request(), {}, ctx());
    expect(handle.data).toEqual({ blocked: true, reason: 'veo_safety' });
    expect(await provider.poll(handle, ctx())).toMatchObject({ status: 'blocked', reason: 'veo_safety' });
    expect(polls).toBe(0);
  });

  it('does not mistake an auth refusal for a content block', async () => {
    const body = [{ error: { code: 403, message: 'Requests are blocked.', status: 'API_KEY_SERVICE_BLOCKED' } }];
    server.use(http.post(SUBMIT, () => HttpResponse.json(body, { status: 403 })));
    const error = await new VeoVideoProvider().submit(request(), {}, ctx()).catch((e: unknown) => e);
    expect(error).toMatchObject({ definitive: true, retryable: false, message: 'veo_http_403', raw: body });
  });

  it('keeps an invalid-param 400 that names safety_settings a definitive request error', async () => {
    const body = { error: { code: 400, message: "Unknown parameter 'safety_settings'.", status: 'INVALID_ARGUMENT' } };
    server.use(http.post(SUBMIT, () => HttpResponse.json(body, { status: 400 })));
    const error = await new VeoVideoProvider().submit(request(), {}, ctx()).catch((e: unknown) => e);
    expect(error).toMatchObject({ definitive: true, message: 'veo_http_400', raw: body });
  });

  it.each([
    [429, true, true],
    [408, true, true],
    [400, true, false],
    [401, true, false],
    [403, true, false],
    [500, false, false],
    [503, false, false],
  ])(
    'maps a %i submit to definitive=%s retryable=%s with a code-only message',
    async (status, definitive, retryable) => {
      server.use(http.post(SUBMIT, () => HttpResponse.json({ error: { message: 'raw provider text' } }, { status })));
      const error = await new VeoVideoProvider().submit(request(), {}, ctx()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderSubmitError);
      expect(error).toMatchObject({ definitive, retryable, message: `veo_http_${status}` });
    }
  );

  it('treats a network failure on submit as not definitive', async () => {
    server.use(http.post(SUBMIT, () => HttpResponse.error()));
    const error = await new VeoVideoProvider().submit(request(), {}, ctx()).catch((e: unknown) => e);
    expect(error).toMatchObject({ definitive: false, message: 'veo_submit_transport' });
  });

  it.each([
    ['no name', {}],
    ['a name outside the operation shape', { name: '../../etc/passwd' }],
  ])('treats a 200 submit with %s as not definitive', async (_label, body) => {
    server.use(http.post(SUBMIT, () => HttpResponse.json(body)));
    const error = await new VeoVideoProvider().submit(request(), {}, ctx()).catch((e: unknown) => e);
    expect(error).toMatchObject({ definitive: false, message: 'veo_submit_unparseable' });
  });

  it('reads an operation without done as running', async () => {
    expect(await pollWith({ name: OPERATION })).toEqual({ status: 'running' });
    expect(await pollWith({ name: OPERATION, done: false })).toEqual({ status: 'running' });
  });

  it('reads the fixture failure as non-retryable, keeping provider text in raw', async () => {
    active = FIXTURES.fails;
    settled = true;
    const result = await new VeoVideoProvider().poll(handleFor(OPERATION), ctx());
    expect(result).toMatchObject({ status: 'failed', retryable: false, message: 'veo_failed' });
    expect(result.status === 'failed' && result.raw).toEqual(exchange(FIXTURES.fails, 'poll_terminal').response.body);
  });

  it('reads the live internal failure (done, code 13, no video) as a non-retryable failure', async () => {
    active = FIXTURES.failedInternal;
    settled = true;
    const result = await new VeoVideoProvider().poll(handleFor(OPERATION), ctx());
    expect(result).toMatchObject({ status: 'failed', retryable: false, message: 'veo_failed' });
    expect(result.status === 'failed' && result.raw).toEqual(
      exchange(FIXTURES.failedInternal, 'poll_terminal').response.body
    );
  });

  it('reads the fixture RAI filter as blocked without marking it billed', async () => {
    active = FIXTURES.blocked;
    settled = true;
    const result = await new VeoVideoProvider().poll(handleFor(OPERATION), ctx());
    expect(result).toMatchObject({ status: 'blocked', reason: 'veo_safety' });
    expect(result).not.toHaveProperty('billed');
  });

  it('reads filter reasons without a count as blocked', async () => {
    expect(await pollWith(doneWith({ raiMediaFilteredReasons: ['reason'] }))).toMatchObject({ status: 'blocked' });
  });

  it('prefers a video over a filter count', async () => {
    const result = await pollWith(
      doneWith({
        generatedSamples: [{ video: { uri: `${BASE}/v1beta/files/x:download` } }],
        raiMediaFilteredCount: 1,
      })
    );
    expect(result).toMatchObject({ status: 'succeeded' });
  });

  it('reads a done operation with a safety error as blocked', async () => {
    const result = await pollWith({ name: OPERATION, done: true, error: { code: 3, message: 'x', status: 'SAFETY' } });
    expect(result).toMatchObject({ status: 'blocked', reason: 'veo_safety' });
    expect(result).not.toHaveProperty('billed');
  });

  it('reads a done operation with a block-phrased error message as blocked', async () => {
    const result = await pollWith({
      name: OPERATION,
      done: true,
      error: { code: 3, message: 'The prompt was blocked for safety reasons.' },
    });
    expect(result).toMatchObject({ status: 'blocked' });
  });

  it.each(['Rejected under our usage guidelines.', 'Violates Responsible AI practices.', 'Content policy violation.'])(
    'reads a done operation error worded %j as blocked',
    async message => {
      expect(await pollWith({ name: OPERATION, done: true, error: { code: 3, message } })).toMatchObject({
        status: 'blocked',
        reason: 'veo_safety',
      });
    }
  );

  it('fails a done operation with neither a video nor a filter verdict', async () => {
    expect(await pollWith(doneWith({ generatedSamples: [] }))).toMatchObject({
      status: 'failed',
      retryable: false,
      message: 'veo_no_video',
    });
  });

  it('maps the unknown-operation 403 and a 404 to a non-retryable failure', async () => {
    const forbidden = exchange(FIXTURES.unknownOperation, 'poll_terminal').response;
    expect(await pollWith(forbidden.body, forbidden.status)).toMatchObject({
      status: 'failed',
      retryable: false,
      message: 'veo_operation_not_found',
    });
    expect(await pollWith({ error: { code: 404, message: 'not found' } }, 404)).toMatchObject({
      message: 'veo_operation_not_found',
    });
  });

  it('throws on a bare 403 (an auth problem on a running, billed job) so the engine retries', async () => {
    await expect(pollWith({ error: { code: 403, message: 'API key not valid.' } }, 403)).rejects.toThrow(
      'veo_poll_http_403'
    );
  });

  it('a 5xx poll throws so the engine retries', async () => {
    await expect(pollWith({}, 502)).rejects.toThrow('veo_poll_http_502');
  });

  it('an unparseable poll throws', async () => {
    await expect(pollWith({ done: true })).rejects.toThrow('veo_poll_unparseable');
  });

  it('rejects a handle whose operation name is not the documented shape', async () => {
    await expect(new VeoVideoProvider().poll(handleFor('../x'), ctx())).rejects.toThrow(
      'veo_handle_without_operation_name'
    );
    await expect(new VeoVideoProvider().poll({ provider: 'veo', data: {} }, ctx())).rejects.toThrow(
      'veo_handle_without_operation_name'
    );
  });

  it('fetchOutput adds alt=media, sends the key to the Gemini host and returns the bytes', async () => {
    let query = '';
    server.use(
      http.get(DOWNLOAD_PATH, ({ request: r }) => {
        query = new URL(r.url).search;
        seenKeys.push(r.headers.get('x-goog-api-key'));
        return new HttpResponse(VIDEO_BYTES, { headers: { 'content-type': 'video/mp4' } });
      })
    );
    const bytes = await new VeoVideoProvider().fetchOutput(
      { kind: 'url', url: `${BASE}/v1beta/files/abc:download`, requiresAuth: true, contentType: 'video/mp4' },
      ctx()
    );
    expect(bytes.equals(VIDEO_BYTES)).toBe(true);
    expect(query).toBe('?alt=media');
    expect(seenKeys).toEqual([KEY]);
  });

  it('fetchOutput follows a redirect once without the key', async () => {
    const keys: Array<string | null> = [];
    server.use(
      http.get(DOWNLOAD_PATH, ({ request: r }) => {
        keys.push(r.headers.get('x-goog-api-key'));
        return new HttpResponse(null, { status: 302, headers: { location: 'https://storage.example.com/clip.mp4' } });
      }),
      http.get('https://storage.example.com/clip.mp4', ({ request: r }) => {
        keys.push(r.headers.get('x-goog-api-key'));
        return new HttpResponse(VIDEO_BYTES);
      })
    );
    const bytes = await new VeoVideoProvider().fetchOutput(
      { kind: 'url', url: `${BASE}/v1beta/files/abc:download`, requiresAuth: true },
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
    await expect(new VeoVideoProvider().fetchOutput({ kind: 'url', url, requiresAuth: true }, ctx())).rejects.toThrow(
      'veo_untrusted_output_url'
    );
    expect(reached).toBe(false);
  });

  it.each([404, 410])('fetchOutput throws ProviderOutputUnavailableError on %i', async status => {
    server.use(http.get(DOWNLOAD_PATH, () => new HttpResponse(null, { status })));
    const error = await new VeoVideoProvider()
      .fetchOutput({ kind: 'url', url: `${BASE}/v1beta/files/gone:download`, requiresAuth: true }, ctx())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderOutputUnavailableError);
    expect(error).toMatchObject({ status });
  });

  it('declares no cancel, since the docs show no operations cancel for Veo', () => {
    expect(new VeoVideoProvider().cancel).toBeUndefined();
  });
});
