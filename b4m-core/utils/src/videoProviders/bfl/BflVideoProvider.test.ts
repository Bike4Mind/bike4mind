import { existsSync, readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { MAX_VIDEO_OUTPUT_BYTES, type ValidatedVideoRequest } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { describeVideoProviderConformance, type ConformanceScenario } from '../conformance';
import { ProviderOutputTooLargeError, ProviderOutputUnavailableError, ProviderSubmitError } from '../types';
import { BflVideoProvider } from './BflVideoProvider';

type Exchange = {
  name: string;
  request: { method: string; path: string; body?: unknown };
  response: { status: number; headers: Record<string, string>; body?: unknown };
};
type Fixture = { scenario: string; synthetic?: boolean; exchanges: Exchange[] };

const BASE_URL = 'https://api.bfl.ai/v1';
const SUBMIT_URL = `${BASE_URL}/flux-3-video`;
const GET_RESULT_URL = `${BASE_URL}/get_result`;
const VIDEO_URL = 'https://delivery.bfl.ai/synthetic/clip.mp4';
const KEY = 'test-key';
const VIDEO_BYTES = Buffer.from('fake-mp4-bytes');

const load = (name: string): Fixture => {
  const recorded = new URL(`./__fixtures__/${name}.json`, import.meta.url);
  const synthetic = new URL(`./__fixtures__/${name}.synthetic.json`, import.meta.url);
  const file = existsSync(recorded) ? recorded : synthetic;
  return JSON.parse(readFileSync(file, 'utf8')) as Fixture;
};
const FIXTURES = {
  succeeds: load('text-to-video'),
  blocked: load('blocked'),
  fails: load('failed'),
  rejects: load('invalid-param'),
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
const submitBodyOf = (fixture: Fixture) => exchange(fixture, 'submit').response.body;

let active: Fixture = FIXTURES.succeeds;
let settled = false;
const seenAuth: Array<string | null> = [];
const reply = (e: Exchange) =>
  HttpResponse.json(e.response.body as Record<string, unknown>, { status: e.response.status });

const server = setupServer(
  http.post(SUBMIT_URL, ({ request }) => {
    seenAuth.push(request.headers.get('x-key'));
    return reply(exchange(active, 'submit'));
  }),
  http.get(`${GET_RESULT_URL}`, ({ request }) => {
    seenAuth.push(request.headers.get('x-key'));
    return reply(exchange(active, settled ? 'poll_terminal' : 'poll_first'));
  }),
  http.get('https://delivery.bfl.ai/*', ({ request }) => {
    seenAuth.push(request.headers.get('x-key'));
    return new HttpResponse(VIDEO_BYTES, { headers: { 'content-type': 'video/mp4' } });
  })
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const request = (overrides: Partial<ValidatedVideoRequest> = {}) =>
  ({
    model: 'flux-3-video',
    mode: 'text_to_video',
    prompt: 'a lighthouse',
    durationSeconds: 5,
    aspectRatio: '16:9',
    resolution: '720p',
    ...overrides,
  }) as ValidatedVideoRequest;
const ctx = () => ({
  apiKey: KEY,
  logger: new Logger({ metadata: { suite: 'Bfl' } }),
  now: () => new Date('2026-11-10T00:00:00Z'),
  signal: new AbortController().signal,
});
const handleFor = (requestId: string, pollingUrl?: string) => ({
  provider: 'bfl' as const,
  data: { requestId, ...(pollingUrl && { pollingUrl }) },
});
const pollWith = (body: unknown, status = 200, context = ctx()) => {
  server.use(http.get(`${GET_RESULT_URL}`, () => HttpResponse.json(body as Record<string, unknown>, { status })));
  return new BflVideoProvider().poll(handleFor('r1'), context);
};

describeVideoProviderConformance('BflVideoProvider', {
  provider: () => new BflVideoProvider(),
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

describe('BflVideoProvider specifics', () => {
  beforeEach(() => {
    active = FIXTURES.succeeds;
    settled = false;
    seenAuth.length = 0;
  });

  it('has no cancel', () => {
    expect(new BflVideoProvider().cancel).toBeUndefined();
  });

  it('sends the x-key header on submit', async () => {
    let auth: string | null = null;
    server.use(
      http.post(SUBMIT_URL, async ({ request: r }) => {
        auth = r.headers.get('x-key');
        return reply(exchange(FIXTURES.succeeds, 'submit'));
      })
    );
    await new BflVideoProvider().submit(request(), {}, ctx());
    expect(auth).toBe(KEY);
  });

  it('sends the expected submit body fields', async () => {
    let sent: unknown;
    server.use(
      http.post(SUBMIT_URL, async ({ request: r }) => {
        sent = await r.json();
        return reply(exchange(FIXTURES.succeeds, 'submit'));
      })
    );
    await new BflVideoProvider().submit(request({ prompt: 'test prompt', durationSeconds: 5 }), {}, ctx());
    expect(sent).toEqual({
      prompt: 'test prompt',
      mode: 't2v',
      duration: 5,
      aspect_ratio: '16:9',
      resolution: 'hd',
      generate_audio: true,
    });
  });

  it.each([
    ['720p', 'hd', false],
    ['1080p', 'fhd', true],
  ] as const)('maps %s to %s and preserves audio=%s', async (resolution, providerResolution, audio) => {
    let sent: unknown;
    server.use(
      http.post(SUBMIT_URL, async ({ request: submitted }) => {
        sent = await submitted.json();
        return reply(exchange(FIXTURES.succeeds, 'submit'));
      })
    );
    await new BflVideoProvider().submit(request({ resolution, audio }), {}, ctx());
    expect(sent).toMatchObject({ mode: 't2v', duration: 5, resolution: providerResolution, generate_audio: audio });
  });

  it('does not submit unsupported resolution tiers', async () => {
    await expect(new BflVideoProvider().submit(request({ resolution: '480p' }), {}, ctx())).rejects.toMatchObject({
      message: 'bfl_unsupported_resolution',
      definitive: true,
      retryable: false,
    });
    expect(seenAuth).toEqual([]);
  });

  it('returns a handle with requestId and pollingUrl', async () => {
    const handle = await new BflVideoProvider().submit(request(), {}, ctx());
    expect(handle).toEqual({
      provider: 'bfl',
      data: {
        requestId: (submitBodyOf(FIXTURES.succeeds) as { id: string }).id,
        pollingUrl: (submitBodyOf(FIXTURES.succeeds) as { polling_url: string }).polling_url,
      },
    });
  });

  it('maps the invalid-param 422 to a definitive error', async () => {
    active = FIXTURES.rejects;
    const error = await new BflVideoProvider().submit(request(), {}, ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderSubmitError);
    expect(error).toMatchObject({ definitive: true, retryable: false, message: 'bfl_http_422' });
    expect((error as ProviderSubmitError).raw).toEqual(submitBodyOf(FIXTURES.rejects));
  });

  it.each([
    [429, true, true],
    [408, true, true],
    [400, true, false],
    [401, true, false],
    [403, true, false],
    [422, true, false],
    [500, false, false],
    [503, false, false],
  ])('maps a %i submit to definitive=%s retryable=%s', async (status, definitive, retryable) => {
    server.use(http.post(SUBMIT_URL, () => HttpResponse.json({ error: 'test' }, { status })));
    const error = await new BflVideoProvider().submit(request(), {}, ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderSubmitError);
    expect(error).toMatchObject({ definitive, retryable, message: `bfl_http_${status}` });
  });

  it('treats a network failure on submit as an unknown outcome', async () => {
    server.use(http.post(SUBMIT_URL, () => HttpResponse.error()));
    const error = await new BflVideoProvider().submit(request(), {}, ctx()).catch((e: unknown) => e);
    expect(error).toMatchObject({ definitive: false, retryable: false, message: 'bfl_submit_transport' });
  });

  it('treats an unparseable 200 submit as not definitive', async () => {
    server.use(http.post(SUBMIT_URL, () => HttpResponse.json({ status: 'ok' })));
    const error = await new BflVideoProvider().submit(request(), {}, ctx()).catch((e: unknown) => e);
    expect(error).toMatchObject({ definitive: false, message: 'bfl_submit_unparseable' });
  });

  it('polls with the x-key header', async () => {
    await new BflVideoProvider().poll(handleFor('r1'), ctx());
    expect(seenAuth).toEqual([KEY]);
  });

  it.each([
    'http://api.bfl.ai/v1/get_result?id=r1',
    'https://api.bfl.ai.example.com/v1/get_result?id=r1',
    'https://example.com/v1/get_result?id=r1',
    'https://user:password@api.bfl.ai/v1/get_result?id=r1',
  ])('requires a trusted polling URL: %s', async pollingUrl => {
    await expect(new BflVideoProvider().poll(handleFor('r1', pollingUrl), ctx())).rejects.toThrow(
      'bfl_untrusted_polling_url'
    );
    expect(seenAuth).toEqual([]);
  });

  it('polls the returned regional URL with redirects disabled', async () => {
    let redirect: RequestRedirect | undefined;
    server.use(
      http.get('https://api.eu.bfl.ai/v1/get_result', ({ request: polled }) => {
        expect(polled.headers.get('x-key')).toBe(KEY);
        redirect = polled.redirect;
        return HttpResponse.json({ status: 'Pending' });
      })
    );
    await expect(
      new BflVideoProvider().poll(handleFor('r1', 'https://api.eu.bfl.ai/v1/get_result?id=r1'), ctx())
    ).resolves.toEqual({ status: 'running' });
    expect(redirect).toBe('error');
  });

  it('reports running for Pending status', async () => {
    expect(await pollWith({ status: 'Pending' })).toEqual({ status: 'running' });
  });

  it('reports running for Generating status', async () => {
    expect(await pollWith({ status: 'Generating' })).toEqual({ status: 'running' });
  });

  it('reports running for Reasoning status', async () => {
    expect(await pollWith({ status: 'Reasoning' })).toEqual({ status: 'running' });
  });

  it('maps Ready with a sample url to succeeded', async () => {
    settled = true;
    const result = await new BflVideoProvider().poll(handleFor('r1'), ctx());
    expect(result).toEqual({
      status: 'succeeded',
      output: {
        kind: 'url',
        url: expect.stringMatching(/^https:\/\//),
        requiresAuth: false,
        contentType: 'video/mp4',
      },
      reportedDurationSeconds: 5,
    });
  });

  it('maps Ready without a sample to a video_unparsed failure', async () => {
    const c = ctx();
    const error = vi.spyOn(c.logger, 'error').mockImplementation(() => undefined);
    expect(await pollWith({ status: 'Ready', result: {} }, 200, c)).toMatchObject({
      status: 'failed',
      message: 'bfl_video_unparsed',
    });
    expect(error).toHaveBeenCalledWith('bfl_video_unparsed', { status: 'Ready' });
  });

  it('maps Request Moderated to blocked', async () => {
    expect(await pollWith({ status: 'Request Moderated' })).toMatchObject({
      status: 'blocked',
      reason: 'bfl_moderation',
    });
  });

  it('maps Content Moderated to blocked', async () => {
    expect(await pollWith({ status: 'Content Moderated' })).toMatchObject({
      status: 'blocked',
      reason: 'bfl_moderation',
    });
  });

  it('maps Error status to failed', async () => {
    expect(await pollWith({ status: 'Error', result: { error: 'render crash' } })).toMatchObject({
      status: 'failed',
      retryable: false,
      message: 'bfl_failed',
    });
  });

  it('maps No Card Generated to a terminal failure', async () => {
    expect(await pollWith({ status: 'No Card Generated' })).toMatchObject({
      status: 'failed',
      retryable: false,
      message: 'bfl_no_output',
    });
  });

  it('maps Task not found to a terminal failure', async () => {
    expect(await pollWith({ status: 'Task not found' })).toMatchObject({
      status: 'failed',
      retryable: false,
      message: 'bfl_request_not_found',
    });
  });

  it('maps Failed status to failed', async () => {
    expect(await pollWith({ status: 'Failed' })).toMatchObject({
      status: 'failed',
      message: 'bfl_failed',
    });
  });

  it('keeps polling through an unknown status and logs it', async () => {
    const c = ctx();
    const warn = vi.spyOn(c.logger, 'warn').mockImplementation(() => undefined);
    expect(await pollWith({ status: 'SomeNewStatus' }, 200, c)).toEqual({ status: 'running' });
    expect(warn).toHaveBeenCalledWith('bfl_unknown_status', { status: 'SomeNewStatus' });
  });

  it.each([429, 500, 502])('a %i poll throws so the engine retries', async status => {
    await expect(pollWith({}, status)).rejects.toThrow(`bfl_poll_http_${status}`);
  });

  it('an unparseable 200 poll throws', async () => {
    await expect(pollWith({ nope: true })).rejects.toThrow('bfl_poll_unparseable');
  });

  it('a handle without a request id is a programmer error', async () => {
    await expect(new BflVideoProvider().poll({ provider: 'bfl', data: {} }, ctx())).rejects.toThrow(
      'bfl_handle_without_request_id'
    );
  });

  it('fetchOutput downloads WITHOUT the x-key header', async () => {
    settled = true;
    const provider = new BflVideoProvider();
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
        auths.push(r.headers.get('x-key'));
        return new HttpResponse(null, { status: 302, headers: { location: 'https://storage.example.com/clip.mp4' } });
      }),
      http.get('https://storage.example.com/clip.mp4', ({ request: r }) => {
        auths.push(r.headers.get('x-key'));
        return new HttpResponse(VIDEO_BYTES, { headers: { 'content-type': 'video/mp4' } });
      })
    );
    const bytes = await new BflVideoProvider().fetchOutput({ kind: 'url', url: VIDEO_URL, requiresAuth: false }, ctx());
    expect(bytes.equals(VIDEO_BYTES)).toBe(true);
    expect(auths).toEqual([null, null]);
  });

  it('fetchOutput refuses a non-https url', async () => {
    await expect(
      new BflVideoProvider().fetchOutput(
        { kind: 'url', url: 'http://delivery.bfl.ai/clip.mp4', requiresAuth: false },
        ctx()
      )
    ).rejects.toThrow('bfl_untrusted_output_url');
  });

  it.each([403, 404, 410])('fetchOutput throws ProviderOutputUnavailableError on %i', async status => {
    server.use(http.get(VIDEO_URL, () => new HttpResponse(null, { status })));
    const error = await new BflVideoProvider()
      .fetchOutput({ kind: 'url', url: VIDEO_URL, requiresAuth: false }, ctx())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderOutputUnavailableError);
    expect(error).toMatchObject({ status });
  });

  it('fetchOutput refuses an HTTPS redirect to HTTP', async () => {
    server.use(
      http.get(
        VIDEO_URL,
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { location: 'http://delivery.bfl.ai/clip.mp4' },
          })
      )
    );
    await expect(
      new BflVideoProvider().fetchOutput({ kind: 'url', url: VIDEO_URL, requiresAuth: false }, ctx())
    ).rejects.toThrow('bfl_untrusted_output_url');
  });

  it('fetchOutput enforces the output byte limit', async () => {
    server.use(
      http.get(
        VIDEO_URL,
        () =>
          new HttpResponse(VIDEO_BYTES, {
            headers: { 'content-length': String(MAX_VIDEO_OUTPUT_BYTES + 1) },
          })
      )
    );
    await expect(
      new BflVideoProvider().fetchOutput({ kind: 'url', url: VIDEO_URL, requiresAuth: false }, ctx())
    ).rejects.toBeInstanceOf(ProviderOutputTooLargeError);
  });

  it('never logs the api key', async () => {
    const c = ctx();
    const spies = [vi.spyOn(c.logger, 'error'), vi.spyOn(c.logger, 'warn'), vi.spyOn(c.logger, 'info')];
    spies.forEach(spy => spy.mockImplementation(() => undefined));
    server.use(http.get(`${GET_RESULT_URL}`, () => HttpResponse.json({ status: 'SomeNewStatus' })));
    await new BflVideoProvider().poll(handleFor('r1'), c);
    expect(JSON.stringify(spies.map(spy => spy.mock.calls))).not.toContain(KEY);
  });
});
