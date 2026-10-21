import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { MAX_MUSIC_OUTPUT_BYTES, type ValidatedMusicRequest } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { describeSyncProviderConformance, type SyncConformanceScenario } from '../../generationProviders/conformance';
import { syntheticMp3, syntheticMp3Seconds } from '../__fixtures__/syntheticMp3';
import { ProviderOutputTooLargeError, ProviderSubmitError } from '../types';
import { buildLyriaInput, LyriaMusicProvider, normalizeLyriaLyrics } from './LyriaMusicProvider';

type Exchange = {
  name: string;
  request: { method: string; path: string; body?: unknown };
  response: { status: number; headers: Record<string, string>; body?: unknown };
};
type Fixture = { scenario: string; exchanges: Exchange[] };

const INTERACTIONS = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const KEY = 'test-key';
const AUDIO_FRAMES = 300;
const AUDIO = syntheticMp3({ frames: AUDIO_FRAMES, bitrateKbps: 192 });

const load = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}.json`, import.meta.url), 'utf8')) as Fixture;
const FIXTURES: Record<SyncConformanceScenario | 'instrumental', Fixture> = {
  succeeds: load('song'),
  instrumental: load('clip-instrumental'),
  blocked: load('blocked'),
  fails: load('invalid-param'),
};

// Fixtures never carry audio (the recorder replaces each base64 `data` with its length); serve a real MP3 instead.
const withAudio = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withAudio);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      key === 'data' && typeof inner === 'string' && inner.startsWith('<redacted:base64')
        ? AUDIO.toString('base64')
        : withAudio(inner),
    ])
  );
};

let active: Fixture = FIXTURES.succeeds;
const seen: Array<{ key: string | null; body: unknown }> = [];

const server = setupServer(
  http.post(INTERACTIONS, async ({ request }) => {
    seen.push({ key: request.headers.get('x-goog-api-key'), body: await request.json() });
    const { response } = active.exchanges[0];
    return HttpResponse.json(withAudio(response.body) as Record<string, unknown>, { status: response.status });
  })
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  seen.length = 0;
});
afterAll(() => server.close());

const request = (overrides: Partial<ValidatedMusicRequest> = {}) =>
  ({
    model: 'lyria-3.5',
    prompt: 'A warm indie pop song',
    durationSeconds: 60,
    instrumental: false,
    ...overrides,
  }) as ValidatedMusicRequest;
const ctx = () => ({
  apiKey: KEY,
  logger: new Logger({ metadata: { suite: 'Lyria' } }),
  now: () => new Date('2026-10-13T00:00:00Z'),
  signal: new AbortController().signal,
});
const provider = new LyriaMusicProvider();
const generateWith = (fixture: Fixture, overrides: Partial<ValidatedMusicRequest> = {}) => {
  active = fixture;
  return provider.generate(request(overrides), {}, ctx());
};
const respondWith = (body: Record<string, unknown>, status = 200) =>
  server.use(http.post(INTERACTIONS, () => HttpResponse.json(body, { status })));

describeSyncProviderConformance('LyriaMusicProvider', {
  provider: () => new LyriaMusicProvider(),
  context: { apiKey: KEY },
  scenario: name => {
    active = FIXTURES[name];
    return request();
  },
});

describe('buildLyriaInput', () => {
  it('steers length by prompt for a prompt-steered model and sets the lyrics apart', () => {
    expect(buildLyriaInput(request({ lyrics: '[Verse]\nla la' }))).toBe(
      'A warm indie pop song\n\nMake it about 60 seconds long.\n\nLyrics:\n[Verse]\nla la'
    );
  });

  it('asks for no vocals when instrumental', () => {
    expect(buildLyriaInput(request({ instrumental: true }))).toBe(
      'A warm indie pop song\n\nMake it about 60 seconds long.\n\nInstrumental only, no vocals.'
    );
  });

  it('sends no length hint to the fixed-length clip model', () => {
    expect(buildLyriaInput(request({ model: 'lyria-3-clip-preview', durationSeconds: 30 }))).toBe(
      'A warm indie pop song'
    );
  });
});

describe('normalizeLyriaLyrics', () => {
  it('turns section markers into blank lines and drops line prefixes', () => {
    expect(normalizeLyriaLyrics('[[A0]]\n[[B1]]\n[:] Coffee on the sill\n[:] Still\n[[C2]]\n[:] Stay a while')).toBe(
      'Coffee on the sill\nStill\n\nStay a while'
    );
  });

  it('drops an empty sung line instead of leaving a blank line inside a section', () => {
    expect(normalizeLyriaLyrics('[[A0]]\n[:] One\n[:]\n[:] Two')).toBe('One\nTwo');
  });

  it('drops filled-in line timings, and lines that hold only a timing', () => {
    expect(normalizeLyriaLyrics('[[A0]]\n[3.4:6.9] windows down\n[7:12.25]\n[12.25:15] summer air')).toBe(
      'windows down\nsummer air'
    );
  });

  it('keeps bracketed text that is not a timing', () => {
    expect(normalizeLyriaLyrics('[:] [Chorus] hold on')).toBe('[Chorus] hold on');
  });

  it('keeps a timing that is not at the start of the line', () => {
    expect(normalizeLyriaLyrics('[:] hold on [3:4] and [:]')).toBe('hold on [3:4] and [:]');
    expect(normalizeLyriaLyrics('hold on [3:4]')).toBe('hold on [3:4]');
  });

  it('returns undefined for an instrumental or a structure with no lines', () => {
    expect(normalizeLyriaLyrics('<instrumental>')).toBeUndefined();
    expect(normalizeLyriaLyrics('[[A0]]\n[[B1]]\n[[C2]]')).toBeUndefined();
  });
});

describe('LyriaMusicProvider', () => {
  it('makes one blocking call with the key, model and built prompt', async () => {
    await generateWith(FIXTURES.succeeds, { lyrics: 'la la' });

    expect(seen).toEqual([
      { key: KEY, body: { model: 'lyria-3.5', input: buildLyriaInput(request({ lyrics: 'la la' })) } },
    ]);
  });

  it('returns the audio inline with the lyrics it sang and the duration read from the audio', async () => {
    const result = await generateWith(FIXTURES.succeeds);

    expect(result).toMatchObject({
      status: 'succeeded',
      output: { kind: 'inline', base64: AUDIO.toString('base64'), contentType: 'audio/mpeg' },
    });
    if (result.status !== 'succeeded') return;
    expect(result.reportedDurationSeconds).toBeCloseTo(syntheticMp3Seconds(AUDIO_FRAMES, 192), 6);
    expect(result.lyrics).toMatch(/^Coffee on the window sill\nThe city waking slow and still\n/);
    expect(result.lyrics).not.toMatch(/\[:\]|\[\[/);
    expect((await provider.fetchOutput(result.output)).equals(AUDIO)).toBe(true);
  });

  it('reports no lyrics for an instrumental clip', async () => {
    const result = await generateWith(FIXTURES.instrumental);

    expect(result.status).toBe('succeeded');
    if (result.status === 'succeeded') expect(result.lyrics).toBeUndefined();
  });

  it('reports the safety 400 as blocked', async () => {
    expect(await generateWith(FIXTURES.blocked)).toMatchObject({ status: 'blocked', reason: 'gemini_lyria_safety' });
  });

  it('fails a refused request without retrying', async () => {
    expect(await generateWith(FIXTURES.fails)).toMatchObject({
      status: 'failed',
      retryable: false,
      message: 'gemini_lyria_http_400',
    });
  });

  it('lets a throttled call be retried, since nothing was generated', async () => {
    respondWith({ error: { code: 429, message: 'Resource exhausted' } }, 429);

    expect(await provider.generate(request(), {}, ctx())).toMatchObject({ status: 'failed', retryable: true });
  });

  it('does not retry a 408: on a blocking call it can arrive after the song was rendered and billed', async () => {
    respondWith({ error: { code: 408, message: 'Request timeout' } }, 408);

    expect(await provider.generate(request(), {}, ctx())).toMatchObject({ status: 'failed', retryable: false });
  });

  it('does not retry a 5xx, which may have generated and billed a song', async () => {
    respondWith({ error: { code: 500, message: 'Internal error' } }, 500);

    expect(await provider.generate(request(), {}, ctx())).toMatchObject({
      status: 'failed',
      retryable: false,
      message: 'gemini_lyria_http_500',
    });
  });

  it('blocks rather than succeeds when the interaction completes without audio', async () => {
    respondWith({
      id: 'x',
      status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'text', text: 'No' }] }],
    });

    expect(await provider.generate(request(), {}, ctx())).toMatchObject({
      status: 'blocked',
      reason: 'gemini_lyria_no_audio',
    });
  });

  it('reports a safety finish on a non-completed interaction as blocked', async () => {
    respondWith({ id: 'x', status: 'failed', error: { code: 'prohibited_content', message: 'Input blocked' } });

    expect(await provider.generate(request(), {}, ctx())).toMatchObject({ status: 'blocked' });
  });

  it('fails any other non-completed interaction without retrying', async () => {
    respondWith({ id: 'x', status: 'incomplete' });

    expect(await provider.generate(request(), {}, ctx())).toMatchObject({
      status: 'failed',
      retryable: false,
      message: 'gemini_lyria_incomplete',
    });
  });

  it('fails an unreadable 2xx without retrying', async () => {
    server.use(http.post(INTERACTIONS, () => new HttpResponse('not json', { status: 200 })));

    expect(await provider.generate(request(), {}, ctx())).toMatchObject({
      status: 'failed',
      retryable: false,
      message: 'gemini_lyria_unparseable',
    });
  });

  it('does not measure audio that is not MP3', async () => {
    respondWith({
      id: 'x',
      status: 'completed',
      steps: [
        { type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: AUDIO.toString('base64') }] },
      ],
    });

    const result = await provider.generate(request(), {}, ctx());

    expect(result).toMatchObject({ status: 'succeeded', output: { contentType: 'audio/wav' } });
    expect(result).not.toHaveProperty('reportedDurationSeconds');
  });

  it('refuses a response larger than the output cap allows', async () => {
    const declared = String(Math.ceil((MAX_MUSIC_OUTPUT_BYTES * 4) / 3) + 2 * 1024 * 1024);
    server.use(http.post(INTERACTIONS, () => new HttpResponse('{}', { headers: { 'content-length': declared } })));

    await expect(provider.generate(request(), {}, ctx())).rejects.toBeInstanceOf(ProviderOutputTooLargeError);
  });

  it('treats a body cut off mid-read as an unknown outcome, like a failed request', async () => {
    server.use(
      http.post(
        INTERACTIONS,
        () =>
          new HttpResponse(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"id":"x","status":"comp'));
                controller.error(new Error('connection reset'));
              },
            })
          )
      )
    );

    const error = await provider.generate(request(), {}, ctx()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderSubmitError);
    expect(error).toMatchObject({ definitive: false, message: 'gemini_lyria_transport' });
  });

  it('throws on a transport error: the song may exist, so the job must not call again', async () => {
    server.use(http.post(INTERACTIONS, () => HttpResponse.error()));

    const error = await provider.generate(request(), {}, ctx()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderSubmitError);
    expect((error as ProviderSubmitError).definitive).toBe(false);
  });

  it('refuses url output, which this provider never produces', async () => {
    await expect(provider.fetchOutput({ kind: 'url', url: `${INTERACTIONS}/x`, requiresAuth: true })).rejects.toThrow(
      'gemini_lyria_unexpected_url_output'
    );
  });
});
