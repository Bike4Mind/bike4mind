import { existsSync, readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ValidatedVideoRequest } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { describeVideoProviderConformance, type ConformanceScenario } from '../conformance';
import { ProviderOutputUnavailableError, ProviderSubmitError } from '../types';
import { XaiVideoProvider } from './XaiVideoProvider';

type Exchange = {
  name: string;
  request: { method: string; path: string; body?: unknown };
  response: { status: number; headers: Record<string, string>; body?: unknown };
};
type Fixture = { scenario: string; synthetic?: boolean; exchanges: Exchange[] };

const GENERATIONS = 'https://api.x.ai/v1/videos/generations';
const VIDEOS = 'https://api.x.ai/v1/videos';
const VIDEO_URL = 'https://vidgen.x.ai/synthetic/clip.mp4';
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
const FIXTURES = {
  succeeds: load('text-to-video'),
  image: load('image-to-video'),
  blocked: load('blocked'),
  blockedOutput: load('blocked-output'),
  fails: load('failed'),
  expired: load('expired'),
  rejects: load('invalid-param'),
  malformedId: load('malformed-id'),
} satisfies Record<string, Fixture>;
const CONFORMANCE: Record<ConformanceScenario, Fixture> = {
  succeeds: FIXTURES.succeeds,
  blocked: FIXTURES.blocked,
  fails: FIXTURES.fails,
  rejects: FIXTURES.rejects,
};
const exchange = (fixture: Fixture, name: string): Exchange => {
  const found = fixture.exchanges.find(e => e.name === name);
  if (!found) throw new Error(`${fixture.scenario} has no ${name} exchange`);
  return found;
};
const pollBodyOf = (fixture: Fixture) => exchange(fixture, 'poll_terminal').response.body;
const submitBodyOf = (fixture: Fixture) => exchange(fixture, 'submit').response.body;

// Replays one fixture: submit, then poll_first until settle() flips to poll_terminal.
let active: Fixture = FIXTURES.succeeds;
let settled = false;
const seenAuth: Array<string | null> = [];
const reply = (e: Exchange) =>
  HttpResponse.json(e.response.body as Record<string, unknown>, { status: e.response.status });

const server = setupServer(
  http.post(GENERATIONS, ({ request }) => {
    seenAuth.push(request.headers.get('authorization'));
    return reply(exchange(active, 'submit'));
  }),
  http.get(`${VIDEOS}/:id`, ({ request }) => {
    seenAuth.push(request.headers.get('authorization'));
    return reply(exchange(active, settled ? 'poll_terminal' : 'poll_first'));
  }),
  // The test serves small bytes instead of a real clip.
  http.get('https://vidgen.x.ai/*', ({ request }) => {
    seenAuth.push(request.headers.get('authorization'));
    return new HttpResponse(VIDEO_BYTES, { headers: { 'content-type': 'video/mp4' } });
  })
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
// Per-test server.use() overrides must not leak into the next test (the order-dependent failure mode).
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const request = (overrides: Partial<ValidatedVideoRequest> = {}) =>
  ({
    model: 'grok-imagine-video-1.5',
    mode: 'text_to_video',
    prompt: 'a lighthouse',
    durationSeconds: 2,
    aspectRatio: '16:9',
    resolution: '480p',
    ...overrides,
  }) as ValidatedVideoRequest;
const ctx = () => ({
  apiKey: KEY,
  logger: new Logger({ metadata: { suite: 'Xai' } }),
  now: () => new Date('2026-10-06T00:00:00Z'),
  signal: new AbortController().signal,
});
const handleFor = (requestId: string) => ({ provider: 'xai' as const, data: { requestId } });
const pollWith = (body: unknown, status = 200, context = ctx()) => {
  server.use(http.get(`${VIDEOS}/:id`, () => HttpResponse.json(body as Record<string, unknown>, { status })));
  return new XaiVideoProvider().poll(handleFor('r1'), context);
};

describeVideoProviderConformance('XaiVideoProvider', {
  provider: () => new XaiVideoProvider(),
  context: { apiKey: KEY },
  beforeEach: () => {
    settled = false;
    seenAuth.length = 0;
    server.resetHandlers();
  },
  scenario: name => {
    active = CONFORMANCE[name];
    return request();
  },
  settle: () => {
    settled = true;
  },
});

describe('XaiVideoProvider specifics', () => {
  beforeEach(() => {
    active = FIXTURES.succeeds;
    settled = false;
    seenAuth.length = 0;
  });

  it('has no cancel, because xAI documents none', () => {
    expect(new XaiVideoProvider().cancel).toBeUndefined();
  });

  it('sends exactly the fixture submit body for the matching text-to-video request, with the bearer key', async () => {
    let sent: unknown;
    let auth: string | null = null;
    server.use(
      http.post(GENERATIONS, async ({ request: r }) => {
        sent = await r.json();
        auth = r.headers.get('authorization');
        return reply(exchange(FIXTURES.succeeds, 'submit'));
      })
    );
    const recorded = exchange(FIXTURES.succeeds, 'submit').request.body as { prompt: string; duration: number };
    const handle = await new XaiVideoProvider().submit(
      request({ prompt: recorded.prompt, durationSeconds: recorded.duration }),
      {},
      ctx()
    );
    expect(sent).toEqual(recorded);
    expect(auth).toBe(`Bearer ${KEY}`);
    expect(handle).toEqual({
      provider: 'xai',
      data: { requestId: (submitBodyOf(FIXTURES.succeeds) as { request_id: string }).request_id },
    });
  });

  it('never sends generate_audio or an image for text-to-video', async () => {
    let sent: Record<string, unknown> = {};
    server.use(
      http.post(GENERATIONS, async ({ request: r }) => {
        sent = (await r.json()) as Record<string, unknown>;
        return reply(exchange(FIXTURES.succeeds, 'submit'));
      })
    );
    await new XaiVideoProvider().submit(request(), {}, ctx());
    expect(Object.keys(sent).sort()).toEqual(['aspect_ratio', 'duration', 'model', 'prompt', 'resolution']);
  });

  it('sends the image as a data URI under image.url for image-to-video', async () => {
    let sent: { image?: unknown } = {};
    server.use(
      http.post(GENERATIONS, async ({ request: r }) => {
        sent = (await r.json()) as { image?: unknown };
        return reply(exchange(FIXTURES.image, 'submit'));
      })
    );
    await new XaiVideoProvider().submit(
      request({ mode: 'image_to_video', inputImageFileId: 'f1' }),
      { inputImage: { bytes: Buffer.from('png'), mimeType: 'image/png' } },
      ctx()
    );
    expect(sent.image).toEqual({ url: `data:image/png;base64,${Buffer.from('png').toString('base64')}` });
  });

  it('carries image-to-video through to a succeeded url output', async () => {
    active = FIXTURES.image;
    const provider = new XaiVideoProvider();
    const handle = await provider.submit(
      request({ mode: 'image_to_video', inputImageFileId: 'f1' }),
      { inputImage: { bytes: Buffer.from('png'), mimeType: 'image/png' } },
      ctx()
    );
    expect(await provider.poll(handle, ctx())).toMatchObject({ status: 'running' });
    settled = true;
    expect(await provider.poll(handle, ctx())).toMatchObject({ status: 'succeeded', output: { kind: 'url' } });
  });

  it('refuses image-to-video without an image as a definitive, non-retryable submit error', async () => {
    const error = await new XaiVideoProvider()
      .submit(request({ mode: 'image_to_video', inputImageFileId: 'f1' }), {}, ctx())
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ definitive: true, retryable: false, message: 'xai_missing_input_image' });
  });

  it('maps the invalid-param 400 to a definitive code-only error with the raw body', async () => {
    active = FIXTURES.rejects;
    const error = await new XaiVideoProvider().submit(request(), {}, ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderSubmitError);
    expect(error).toMatchObject({ definitive: true, retryable: false, message: 'xai_http_400' });
    expect((error as ProviderSubmitError).raw).toEqual(submitBodyOf(FIXTURES.rejects));
  });

  // A recording may show moderation arriving after generation (200, then respect_moderation false) instead.
  it('maps the blocked fixture to a blocked outcome, offline when it is a submit-time rejection', async () => {
    active = FIXTURES.blocked;
    const provider = new XaiVideoProvider();
    if (exchange(FIXTURES.blocked, 'submit').response.status < 400) {
      const handle = await provider.submit(request(), {}, ctx());
      settled = true;
      expect(await provider.poll(handle, ctx())).toMatchObject({ status: 'blocked' });
      return;
    }
    let polls = 0;
    server.use(
      http.get(`${VIDEOS}/:id`, () => {
        polls += 1;
        return HttpResponse.json({});
      })
    );
    const handle = await provider.submit(request(), {}, ctx());
    expect(handle.data).toEqual({ blocked: true, reason: 'xai_moderation' });
    const result = await provider.poll(handle, ctx());
    expect(result).toMatchObject({ status: 'blocked', reason: 'xai_moderation' });
    // Nothing was generated at submit time, so nothing was billed.
    expect(result).not.toHaveProperty('billed');
    expect(polls).toBe(0);
  });

  it.each(['invalid-argument', 'invalid_argument'])(
    'normalises the %s code when matching a moderation block',
    async code => {
      server.use(
        http.post(GENERATIONS, () =>
          HttpResponse.json({ code, error: 'Request blocked by moderation' }, { status: 400 })
        )
      );
      const handle = await new XaiVideoProvider().submit(request(), {}, ctx());
      expect(handle.data).toEqual({ blocked: true, reason: 'xai_moderation' });
    }
  );

  it('reads the nested { error: { code, message } } envelope as a moderation block too', async () => {
    server.use(
      http.post(GENERATIONS, () =>
        HttpResponse.json(
          { error: { code: 'invalid_argument', message: 'Rejected by content moderation' } },
          { status: 400 }
        )
      )
    );
    const handle = await new XaiVideoProvider().submit(request(), {}, ctx());
    expect(handle.data).toEqual({ blocked: true, reason: 'xai_moderation' });
  });

  it('keeps a moderation-worded message under another code a definitive error, not a block', async () => {
    server.use(
      http.post(GENERATIONS, () =>
        HttpResponse.json({ code: 'permission-denied', error: 'blocked: bad key' }, { status: 403 })
      )
    );
    const error = await new XaiVideoProvider().submit(request(), {}, ctx()).catch((e: unknown) => e);
    expect(error).toMatchObject({ definitive: true, retryable: false, message: 'xai_http_403' });
  });

  // 5xx and network errors are not definitive: the job may exist and be billed, so the engine never resubmits them
  // (retryable only matters when definitive, so it keeps its default there).
  it.each([
    [429, true, true],
    [408, true, true],
    [400, true, false],
    [401, true, false],
    [403, true, false],
    [422, true, false],
    [500, false, false],
    [503, false, false],
  ])(
    'maps a %i submit to definitive=%s retryable=%s with a code-only message',
    async (status, definitive, retryable) => {
      server.use(
        http.post(GENERATIONS, () => HttpResponse.json({ code: 'x', error: 'raw provider text' }, { status }))
      );
      const error = await new XaiVideoProvider().submit(request(), {}, ctx()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderSubmitError);
      expect(error).toMatchObject({ definitive, retryable, message: `xai_http_${status}` });
      expect((error as ProviderSubmitError).raw).toEqual({ code: 'x', error: 'raw provider text' });
    }
  );

  it('treats a network failure on submit as an unknown outcome, never resubmitted', async () => {
    server.use(http.post(GENERATIONS, () => HttpResponse.error()));
    const error = await new XaiVideoProvider().submit(request(), {}, ctx()).catch((e: unknown) => e);
    expect(error).toMatchObject({ definitive: false, retryable: false, message: 'xai_submit_transport' });
  });

  it('treats an unparseable 200 submit as not definitive', async () => {
    server.use(http.post(GENERATIONS, () => HttpResponse.json({ status: 'pending' })));
    const error = await new XaiVideoProvider().submit(request(), {}, ctx()).catch((e: unknown) => e);
    expect(error).toMatchObject({ definitive: false, message: 'xai_submit_unparseable' });
  });

  it('polls with the bearer key and passes progress through as a 0..1 fraction', async () => {
    const result = await new XaiVideoProvider().poll(handleFor('r1'), ctx());
    const reported = (exchange(FIXTURES.succeeds, 'poll_first').response.body as { progress: number }).progress;
    expect(result).toEqual({ status: 'running', progress: reported / 100 });
    expect(await pollWith({ status: 'pending', progress: 40 })).toEqual({ status: 'running', progress: 0.4 });
    expect(seenAuth).toEqual([`Bearer ${KEY}`]);
  });

  it('reports running without progress when the poll carries none', async () => {
    expect(await pollWith({ status: 'pending', progress: null })).toEqual({ status: 'running' });
  });

  it('maps done with a url to succeeded, taking the reported duration from video.duration', async () => {
    settled = true;
    expect(await new XaiVideoProvider().poll(handleFor('r1'), ctx())).toEqual({
      status: 'succeeded',
      output: { kind: 'url', url: expect.stringMatching(/^https:\/\//), requiresAuth: false, contentType: 'video/mp4' },
      reportedDurationSeconds: 2,
    });
  });

  it('maps done with respect_moderation false to blocked, even when a url is present', async () => {
    expect(
      await pollWith({ status: 'done', video: { url: VIDEO_URL, duration: 2, respect_moderation: false } })
    ).toEqual(expect.objectContaining({ status: 'blocked', reason: 'xai_moderation', billed: true }));
  });

  it('maps a moderated output seen live (a poll 400, still billed) to blocked instead of throwing', async () => {
    const { status, body } = exchange(FIXTURES.blockedOutput, 'poll_terminal').response;
    expect(status).toBe(400);
    expect(await pollWith(body, status)).toEqual({
      status: 'blocked',
      reason: 'xai_moderation',
      billed: true,
      raw: body,
    });
  });

  it('carries the blocked-output fixture through submit, pending poll and a blocked poll', async () => {
    active = FIXTURES.blockedOutput;
    const provider = new XaiVideoProvider();
    const handle = await provider.submit(request(), {}, ctx());
    expect(await provider.poll(handle, ctx())).toMatchObject({ status: 'running' });
    settled = true;
    expect(await provider.poll(handle, ctx())).toMatchObject({ status: 'blocked' });
  });

  it.each([
    ['imagine:content-moderated', 400],
    ['IMAGINE:CONTENT-MODERATED', 400],
    ['content-moderated', 422],
  ])('reads the namespaced or hyphenated code %s on a poll %i as blocked', async (code, status) => {
    expect(await pollWith({ code, error: 'Rejected' }, status)).toMatchObject({ status: 'blocked' });
  });

  it('keeps a namespaced non-moderation poll 400 a thrown error', async () => {
    await expect(pollWith({ code: 'imagine:rate-limited', error: 'Slow down' }, 400)).rejects.toThrow(
      'xai_poll_http_400'
    );
  });

  it('maps done with no url to a non-retryable video_unparsed failure and logs it', async () => {
    const c = ctx();
    const error = vi.spyOn(c.logger, 'error').mockImplementation(() => undefined);
    server.use(
      http.get(`${VIDEOS}/:id`, () => HttpResponse.json({ status: 'done', video: { respect_moderation: true } }))
    );
    expect(await new XaiVideoProvider().poll(handleFor('r1'), c)).toMatchObject({
      status: 'failed',
      retryable: false,
      message: 'xai_video_unparsed',
    });
    expect(error).toHaveBeenCalledWith('xai_video_unparsed', { status: 'done' });
  });

  it('reads the fixture failure as non-retryable, keeping provider text in raw', async () => {
    active = FIXTURES.fails;
    const result = await pollWith(pollBodyOf(FIXTURES.fails));
    expect(result).toMatchObject({ status: 'failed', retryable: false, message: 'xai_failed' });
    expect(result.status === 'failed' && result.raw).toMatchObject(pollBodyOf(FIXTURES.fails) as object);
  });

  it.each([
    [{ code: 'invalid_argument', message: 'Content blocked by moderation' }],
    [{ code: 'moderation_blocked', message: 'Rejected' }],
    [{ code: 'content_blocked', message: 'Something happened' }],
    [{ code: 'CONTENT-BLOCKED' }],
    [{ code: 'internal_error', message: 'Rejected by safety filters' }],
    [{ code: 'failed_precondition', message: 'Prompt violates usage policy' }],
  ])('maps a failed job whose error indicates moderation (%o) to blocked', async error => {
    const result = await pollWith({ status: 'failed', error });
    expect(result).toMatchObject({ status: 'blocked', reason: 'xai_moderation' });
    expect(result).not.toHaveProperty('billed');
  });

  it.each([
    [{ code: 'service_unavailable', message: 'Request blocked: rate limit exceeded' }],
    [{ code: 'internal_error', message: 'Upstream blocked waiting on GPU' }],
    [{ code: 'permission_denied', message: 'Account blocked' }],
    [{ code: 'permission_denied', message: 'Request rejected by rate limit policy' }],
    [{ code: 'resource_exhausted', message: 'Quota exceeded: request blocked by usage policy' }],
    [{ code: 'permission_denied', message: 'API key rejected, check your key policy' }],
    [{ code: 'unblocked_retry', message: 'Try again' }],
  ])('keeps a failed job that merely says "blocked" (%o) a plain failure', async error => {
    expect(await pollWith({ status: 'failed', error })).toMatchObject({ status: 'failed', message: 'xai_failed' });
  });

  it('does not read a submit 400 saying "Request blocked: rate limit exceeded" as a content block', async () => {
    server.use(
      http.post(GENERATIONS, () =>
        HttpResponse.json({ code: 'invalid-argument', error: 'Request blocked: rate limit exceeded' }, { status: 400 })
      )
    );
    const error = await new XaiVideoProvider().submit(request(), {}, ctx()).catch((e: unknown) => e);
    expect(error).toMatchObject({ definitive: true, message: 'xai_http_400' });
  });

  it.each(['Rejected by safety filters', 'Prompt violates usage policy'])(
    'reads a submit invalid-argument saying "%s" as a content block',
    async message => {
      server.use(
        http.post(GENERATIONS, () => HttpResponse.json({ code: 'invalid-argument', error: message }, { status: 400 }))
      );
      const handle = await new XaiVideoProvider().submit(request(), {}, ctx());
      expect(handle.data).toEqual({ blocked: true, reason: 'xai_moderation' });
    }
  );

  it('maps expired to a non-retryable failure', async () => {
    expect(await pollWith(pollBodyOf(FIXTURES.expired))).toMatchObject({
      status: 'failed',
      retryable: false,
      message: 'xai_expired',
    });
  });

  it('keeps polling through an unknown status and logs it', async () => {
    const c = ctx();
    const warn = vi.spyOn(c.logger, 'warn').mockImplementation(() => undefined);
    server.use(http.get(`${VIDEOS}/:id`, () => HttpResponse.json({ status: 'queued' })));
    expect(await new XaiVideoProvider().poll(handleFor('r1'), c)).toEqual({ status: 'running' });
    expect(warn).toHaveBeenCalledWith('xai_unknown_status', { status: 'queued' });
  });

  it('a malformed request id 400 (the live envelope) is a non-retryable failure', async () => {
    const { status, body } = exchange(FIXTURES.malformedId, 'poll_terminal').response;
    expect(await pollWith(body, status)).toMatchObject({
      status: 'failed',
      retryable: false,
      message: 'xai_request_not_found',
      raw: body,
    });
  });

  it('a 404 poll is a non-retryable failure', async () => {
    expect(await pollWith({ code: 'not-found', error: 'no such request' }, 404)).toMatchObject({
      status: 'failed',
      retryable: false,
      message: 'xai_request_not_found',
    });
  });

  it.each([429, 500, 502])('a %i poll throws so the engine retries', async status => {
    await expect(pollWith({}, status)).rejects.toThrow(`xai_poll_http_${status}`);
  });

  it.each([
    [400, { code: 'invalid-argument', error: 'Unknown error, please retry' }],
    [401, { code: 'unauthenticated', error: 'Invalid API key' }],
    [403, { code: 'permission-denied', error: 'Forbidden' }],
  ])('a %i poll that does not name the request id throws instead of failing the job', async (status, body) => {
    await expect(pollWith(body, status)).rejects.toThrow(`xai_poll_http_${status}`);
  });

  it('logs the body of a rejected poll at error level, never the key', async () => {
    const c = ctx();
    const error = vi.spyOn(c.logger, 'error').mockImplementation(() => undefined);
    const body = { code: 'unauthenticated', error: 'Invalid API key' };
    await expect(pollWith(body, 401, c)).rejects.toThrow('xai_poll_http_401');
    expect(error).toHaveBeenCalledWith('xai_poll_rejected', { status: 401, raw: body });
    expect(JSON.stringify(error.mock.calls)).not.toContain(KEY);
  });

  it('an unparseable 200 poll throws so the engine retries', async () => {
    await expect(pollWith({ nope: true })).rejects.toThrow('xai_poll_unparseable');
  });

  it('a handle without a request id is a programmer error', async () => {
    await expect(new XaiVideoProvider().poll({ provider: 'xai', data: {} }, ctx())).rejects.toThrow(
      'xai_handle_without_request_id'
    );
  });

  it('fetchOutput downloads WITHOUT the Authorization header', async () => {
    settled = true;
    const provider = new XaiVideoProvider();
    const result = await provider.poll(handleFor('r1'), ctx());
    if (result.status !== 'succeeded') throw new Error(`expected succeeded, got ${result.status}`);
    seenAuth.length = 0;
    const bytes = await provider.fetchOutput(result.output, ctx());
    expect(bytes.equals(VIDEO_BYTES)).toBe(true);
    expect(seenAuth).toEqual([null]);
  });

  it('fetchOutput follows one redirect without credentials', async () => {
    const auths: Array<string | null> = [];
    server.use(
      http.get(VIDEO_URL, ({ request: r }) => {
        auths.push(r.headers.get('authorization'));
        return new HttpResponse(null, { status: 302, headers: { location: 'https://storage.example.com/clip.mp4' } });
      }),
      http.get('https://storage.example.com/clip.mp4', ({ request: r }) => {
        auths.push(r.headers.get('authorization'));
        return new HttpResponse(VIDEO_BYTES, { headers: { 'content-type': 'video/mp4' } });
      })
    );
    const bytes = await new XaiVideoProvider().fetchOutput({ kind: 'url', url: VIDEO_URL, requiresAuth: false }, ctx());
    expect(bytes.equals(VIDEO_BYTES)).toBe(true);
    expect(auths).toEqual([null, null]);
  });

  it('fetchOutput refuses a non-https url and a non-https redirect target', async () => {
    await expect(
      new XaiVideoProvider().fetchOutput(
        { kind: 'url', url: 'http://vidgen.x.ai/clip.mp4', requiresAuth: false },
        ctx()
      )
    ).rejects.toThrow('xai_untrusted_output_url');
    server.use(
      http.get(VIDEO_URL, () => new HttpResponse(null, { status: 302, headers: { location: 'http://evil.example/x' } }))
    );
    await expect(
      new XaiVideoProvider().fetchOutput({ kind: 'url', url: VIDEO_URL, requiresAuth: false }, ctx())
    ).rejects.toThrow('xai_untrusted_output_url');
  });

  it.each([403, 404, 410])('fetchOutput throws ProviderOutputUnavailableError on %i (expired link)', async status => {
    server.use(http.get(VIDEO_URL, () => new HttpResponse(null, { status })));
    const error = await new XaiVideoProvider()
      .fetchOutput({ kind: 'url', url: VIDEO_URL, requiresAuth: false }, ctx())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderOutputUnavailableError);
    expect(error).toMatchObject({ status });
  });

  it('fetchOutput throws on another download failure so the engine retries', async () => {
    server.use(http.get(VIDEO_URL, () => new HttpResponse(null, { status: 502 })));
    await expect(
      new XaiVideoProvider().fetchOutput({ kind: 'url', url: VIDEO_URL, requiresAuth: false }, ctx())
    ).rejects.toThrow('xai_download_http_502');
  });

  it('never logs the api key', async () => {
    const c = ctx();
    const spies = [vi.spyOn(c.logger, 'error'), vi.spyOn(c.logger, 'warn'), vi.spyOn(c.logger, 'info')];
    spies.forEach(spy => spy.mockImplementation(() => undefined));
    server.use(http.get(`${VIDEOS}/:id`, () => HttpResponse.json({ status: 'weird' })));
    await new XaiVideoProvider().poll(handleFor('r1'), c);
    expect(JSON.stringify(spies.map(spy => spy.mock.calls))).not.toContain(KEY);
  });
});
