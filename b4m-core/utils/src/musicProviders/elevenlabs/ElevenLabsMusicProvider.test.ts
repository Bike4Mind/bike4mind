import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { MAX_MUSIC_OUTPUT_BYTES, type ValidatedMusicRequest } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { describeSyncProviderConformance, type SyncConformanceScenario } from '../../generationProviders/conformance';
import { syntheticMp3, syntheticMp3Seconds } from '../__fixtures__/syntheticMp3';
import { ProviderOutputTooLargeError, ProviderSubmitError } from '../types';
import {
  boundaryOf,
  buildElevenLabsMusicBody,
  ElevenLabsMusicProvider,
  ElevenLabsPlanError,
  lyricsFromPlan,
  parseMultipart,
} from './ElevenLabsMusicProvider';

type RecordedPart = { contentType: string; body?: unknown; audio?: { mimeType: string } };
type Exchange = {
  name: string;
  request: { method: string; path: string; body?: unknown };
  response: { status: number; headers: Record<string, string>; body?: unknown; parts?: RecordedPart[] };
};
type Fixture = { scenario: string; exchanges: Exchange[] };

const MUSIC = 'https://api.elevenlabs.io/v1/music/detailed';
const KEY = 'test-key';
const AUDIO_FRAMES = 300;
const AUDIO = syntheticMp3({ frames: AUDIO_FRAMES, id3Bytes: 64 });

const load = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}.json`, import.meta.url), 'utf8')) as Fixture;
const FIXTURES: Record<SyncConformanceScenario | 'instrumental', Fixture> = {
  succeeds: load('song'),
  instrumental: load('instrumental'),
  blocked: load('blocked'),
  fails: load('invalid-param'),
};

type Part = { contentType: string; body: Buffer | string };

const multipart = (boundary: string, parts: Part[]): Buffer =>
  Buffer.concat([
    ...parts.flatMap(part => [
      Buffer.from(`--${boundary}\r\nContent-Type: ${part.contentType}\r\n\r\n`, 'latin1'),
      typeof part.body === 'string' ? Buffer.from(part.body, 'utf8') : part.body,
      Buffer.from('\r\n', 'latin1'),
    ]),
    Buffer.from(`--${boundary}--\r\n`, 'latin1'),
  ]);

const BOUNDARY = '----boundarytest';
const multipartResponse = (parts: Part[], boundary = BOUNDARY) =>
  new HttpResponse(new Uint8Array(multipart(boundary, parts)), {
    headers: { 'content-type': `multipart/mixed; boundary=${boundary}` },
  });

// Fixtures never carry audio (the recorder keeps only its size and length); serve a synthetic MP3 instead.
const replay = (response: Exchange['response']) => {
  if (!response.parts) return HttpResponse.json(response.body as Record<string, unknown>, { status: response.status });
  const boundary = /boundary=(\S+)/.exec(response.headers['content-type'])?.[1] ?? BOUNDARY;
  return multipartResponse(
    response.parts.map(part => ({
      contentType: part.contentType,
      body: part.audio ? AUDIO : JSON.stringify(part.body),
    })),
    boundary
  );
};

let active: Fixture = FIXTURES.succeeds;
const seen: Array<{ key: string | null; url: string; body: unknown }> = [];

const server = setupServer(
  http.post(MUSIC, async ({ request }) => {
    seen.push({ key: request.headers.get('xi-api-key'), url: request.url, body: await request.json() });
    return replay(active.exchanges[0].response);
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
    model: 'music_v2_5',
    prompt: 'Warm acoustic folk song',
    durationSeconds: 20,
    instrumental: false,
    ...overrides,
  }) as ValidatedMusicRequest;
const ctx = () => ({
  apiKey: KEY,
  logger: new Logger({ metadata: { suite: 'ElevenLabsMusic' } }),
  now: () => new Date('2026-10-13T00:00:00Z'),
  signal: new AbortController().signal,
});
const provider = new ElevenLabsMusicProvider();
const generateWith = (fixture: Fixture, overrides: Partial<ValidatedMusicRequest> = {}) => {
  active = fixture;
  return provider.generate(request(overrides), {}, ctx());
};
const respondWith = (response: () => Response) => server.use(http.post(MUSIC, response));

type Body = ReturnType<typeof buildElevenLabsMusicBody>;
type Chunk = { text: string; duration_ms: number };
type V1Section = { section_name: string; duration_ms: number; lines: string[] };
const chunksOf = (body: Body): Chunk[] =>
  'composition_plan' in body && 'chunks' in body.composition_plan ? body.composition_plan.chunks : [];
const sectionsOf = (body: Body): V1Section[] =>
  'composition_plan' in body && 'sections' in body.composition_plan ? body.composition_plan.sections : [];
const totalMs = (items: Array<{ duration_ms: number }>) => items.reduce((sum, item) => sum + item.duration_ms, 0);
const expectValidDurations = (items: Array<{ duration_ms: number }>, expectedTotalMs: number) => {
  expect(totalMs(items)).toBe(expectedTotalMs);
  for (const item of items) {
    expect(Number.isInteger(item.duration_ms)).toBe(true);
    expect(item.duration_ms).toBeGreaterThanOrEqual(3000);
    expect(item.duration_ms).toBeLessThanOrEqual(120_000);
  }
};
const lines = (count: number, prefix = 'line') => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);

describeSyncProviderConformance('ElevenLabsMusicProvider', {
  provider: () => new ElevenLabsMusicProvider(),
  context: { apiKey: KEY },
  scenario: name => {
    active = FIXTURES[name];
    return request();
  },
});

describe('buildElevenLabsMusicBody', () => {
  it('sends the prompt and exact length when there are no lyrics', () => {
    expect(buildElevenLabsMusicBody(request())).toEqual({
      model_id: 'music_v2_5',
      prompt: 'Warm acoustic folk song',
      music_length_ms: 20_000,
      force_instrumental: false,
    });
  });

  it('forces an instrumental', () => {
    expect(buildElevenLabsMusicBody(request({ model: 'music_v2', instrumental: true }))).toMatchObject({
      model_id: 'music_v2',
      force_instrumental: true,
    });
  });

  it('turns tagged lyrics into chunks styled by the prompt, timed by line count', () => {
    const body = buildElevenLabsMusicBody(
      request({ durationSeconds: 30, lyrics: '[Verse]\nOne\n\nTwo\nThree\n[Chorus]\nFour\n[Outro]' })
    );

    expect(body).toEqual({
      model_id: 'music_v2_5',
      composition_plan: {
        chunks: [
          {
            text: '[Verse]\nOne\nTwo\nThree',
            duration_ms: 3000 + 12_600,
            positive_styles: ['Warm acoustic folk song'],
            negative_styles: [],
          },
          {
            text: '[Chorus]\nFour',
            duration_ms: 3000 + 4200,
            positive_styles: ['Warm acoustic folk song'],
            negative_styles: [],
          },
          {
            text: '[Outro]',
            duration_ms: 3000 + 4200,
            positive_styles: ['Warm acoustic folk song'],
            negative_styles: [],
          },
        ],
      },
    });
  });

  it('puts untagged leading lines in a Verse section', () => {
    const chunks = chunksOf(buildElevenLabsMusicBody(request({ lyrics: 'One\r\nTwo\n[Chorus]\nThree' })));

    expect(chunks.map(chunk => chunk.text)).toEqual(['[Verse]\nOne\nTwo', '[Chorus]\nThree']);
    expectValidDurations(chunks, 20_000);
  });

  it('keeps the total exact when the shares do not divide evenly', () => {
    const chunks = chunksOf(buildElevenLabsMusicBody(request({ durationSeconds: 37, lyrics: 'a\n[B]\nb\n[C]\nc' })));

    expect(chunks.map(chunk => chunk.duration_ms)).toEqual([12_334, 12_333, 12_333]);
    expectValidDurations(chunks, 37_000);
  });

  it('merges trailing sections into the last that fits at 3 s each', () => {
    const lyrics = Array.from({ length: 5 }, (_, i) => `[S${i + 1}]\nline ${i + 1}`).join('\n');
    const chunks = chunksOf(buildElevenLabsMusicBody(request({ durationSeconds: 10, lyrics })));

    expect(chunks.map(chunk => chunk.text)).toEqual(['[S1]\nline 1', '[S2]\nline 2', '[S3]\nline 3\nline 4\nline 5']);
    expectValidDurations(chunks, 10_000);
  });

  it('caps the plan at 30 chunks, leaving room for the splits a long song needs', () => {
    const lyrics = Array.from({ length: 40 }, (_, i) => `[S${i + 1}]\nline ${i + 1}`).join('\n');
    const chunks = chunksOf(buildElevenLabsMusicBody(request({ durationSeconds: 300, lyrics })));

    expect(chunks).toHaveLength(28);
    expect(chunks[27].text).toBe(['[S28]', ...Array.from({ length: 13 }, (_, i) => `line ${i + 28}`)].join('\n'));
    expectValidDurations(chunks, 300_000);
  });

  it('keeps a long section within 30 lines a chunk, tag included, when the section count overflows', () => {
    const lyrics = [...Array.from({ length: 29 }, (_, i) => `[S${i + 1}]`), '[Long]', ...lines(200)].join('\n');
    const chunks = chunksOf(buildElevenLabsMusicBody(request({ durationSeconds: 300, lyrics })));

    expect(chunks.length).toBeLessThanOrEqual(30);
    for (const chunk of chunks) expect(chunk.text.split('\n').length).toBeLessThanOrEqual(30);
    expect(chunks.flatMap(chunk => chunk.text.split('\n').slice(1))).toEqual(lines(200));
    expectValidDurations(chunks, 300_000);
  });

  it('splits a v2 section over 29 lyric lines so each chunk stays within 30 lines with its tag', () => {
    const chunks = chunksOf(buildElevenLabsMusicBody(request({ durationSeconds: 60, lyrics: lines(30).join('\n') })));

    expect(chunks.map(chunk => chunk.text.split('\n'))).toEqual([
      ['[Verse]', ...lines(29)],
      ['[Verse]', 'line 30'],
    ]);
  });

  it('repacks lines across sections when whole sections cannot fit the chunks the length allows', () => {
    const lyrics = ['[A]', ...lines(20, 'a'), '[B]', ...lines(20, 'b'), '[C]', ...lines(20, 'c')].join('\n');
    const sections = sectionsOf(buildElevenLabsMusicBody(request({ model: 'music_v1', durationSeconds: 6, lyrics })));

    expect(sections.map(section => [section.section_name, section.lines])).toEqual([
      ['A', [...lines(20, 'a'), ...lines(10, 'b')]],
      ['B', [...lines(10, 'b').map((_, i) => `b ${i + 11}`), ...lines(20, 'c')]],
    ]);
    expectValidDurations(sections, 6000);
  });

  it('merges short sections rather than refusing lyrics that fit', () => {
    const lyrics = Array.from({ length: 60 }, (_, i) => [`[S${i}]`, ...lines(i % 3, `s${i}`)].join('\n')).join('\n');
    const sections = sectionsOf(buildElevenLabsMusicBody(request({ model: 'music_v1', durationSeconds: 300, lyrics })));

    expect(sections.length).toBeLessThanOrEqual(28);
    expect(sections.flatMap(section => section.lines)).toHaveLength(60);
    for (const section of sections) expect(section.lines.length).toBeLessThanOrEqual(30);
    expectValidDurations(sections, 300_000);
  });

  it('splits a section longer than 120 s into continuation chunks, lines with the first', () => {
    const chunks = chunksOf(buildElevenLabsMusicBody(request({ durationSeconds: 250, lyrics: '[Verse]\nOne\nTwo' })));

    expect(chunks.map(chunk => [chunk.text, chunk.duration_ms])).toEqual([
      ['[Verse]\nOne\nTwo', 83_334],
      ['[Verse]', 83_333],
      ['[Verse]', 83_333],
    ]);
    expectValidDurations(chunks, 250_000);
  });

  it('keeps every plan valid, exact and lossless across lengths, section counts and section sizes', () => {
    const lineOf = (section: number, line: number) => `s${section} l${line} `.padEnd(line % 7 === 0 ? 200 : 20, 'x');
    let refused = 0;
    for (const seconds of [3, 4, 7, 20, 59, 121, 240, 299, 300]) {
      const allowedChunks = Math.min(30 - Math.floor(seconds / 120), Math.floor(seconds / 3));
      for (const sectionCount of [1, 2, 5, 31, 45]) {
        for (const linesPerSection of [
          (i: number) => i % 2,
          (i: number) => (i * 7) % 12,
          (i: number) => 25 + (i % 40),
        ]) {
          const sections = Array.from({ length: sectionCount }, (_, i) =>
            Array.from({ length: linesPerSection(i) }, (_, line) => lineOf(i, line))
          );
          const lyricLines = sections.flat();
          const lyrics = sections.map((sectionLines, i) => [`[S${i}]`, ...sectionLines].join('\n')).join('\n');
          for (const model of ['music_v2_5', 'music_v1'] as const) {
            const cap = model === 'music_v1' ? 30 : 29;
            const build = () => buildElevenLabsMusicBody(request({ model, durationSeconds: seconds, lyrics }));
            if (lyricLines.length > allowedChunks * cap) {
              expect(build).toThrow(ElevenLabsPlanError);
              refused += 1;
              continue;
            }
            const body = build();
            const items = model === 'music_v1' ? sectionsOf(body) : chunksOf(body);
            const itemLines = items.map(item => ('lines' in item ? item.lines : item.text.split('\n')));
            expect(items.length).toBeLessThanOrEqual(30);
            for (const linesOut of itemLines) {
              expect(linesOut.length).toBeLessThanOrEqual(30);
              for (const line of linesOut) expect(line.length).toBeLessThanOrEqual(200);
            }
            const lyricLinesOut =
              model === 'music_v1' ? itemLines.flat() : itemLines.flatMap(linesOut => linesOut.slice(1));
            expect(lyricLinesOut).toEqual(lyricLines);
            expectValidDurations(items, seconds * 1000);
          }
        }
      }
    }
    expect(refused).toBeGreaterThan(0);
  });

  it('builds the v1 section plan with the prompt as the global style', () => {
    expect(buildElevenLabsMusicBody(request({ model: 'music_v1', lyrics: '[Verse]\nOne\n[Chorus]\nTwo' }))).toEqual({
      model_id: 'music_v1',
      composition_plan: {
        positive_global_styles: ['Warm acoustic folk song'],
        negative_global_styles: [],
        sections: [
          {
            section_name: 'Verse',
            positive_local_styles: [],
            negative_local_styles: [],
            duration_ms: 10_000,
            lines: ['One'],
          },
          {
            section_name: 'Chorus',
            positive_local_styles: [],
            negative_local_styles: [],
            duration_ms: 10_000,
            lines: ['Two'],
          },
        ],
      },
    });
  });

  it('splits a v1 section over 30 lines into continuation sections', () => {
    const sections = sectionsOf(
      buildElevenLabsMusicBody(request({ model: 'music_v1', durationSeconds: 60, lyrics: lines(65).join('\n') }))
    );

    expect(sections.map(section => [section.section_name, section.lines.length])).toEqual([
      ['Verse', 30],
      ['Verse', 30],
      ['Verse', 5],
    ]);
    expect(sections.flatMap(section => section.lines)).toEqual(lines(65));
    expectValidDurations(sections, 60_000);
  });

  it('caps a v1 section name at 100 characters', () => {
    const sections = sectionsOf(
      buildElevenLabsMusicBody(request({ model: 'music_v1', lyrics: `[${'x'.repeat(120)}]\nOne` }))
    );

    expect(sections[0].section_name).toHaveLength(100);
  });

  it('refuses lyrics with more lines than the allowed chunks can hold', () => {
    expect(() =>
      buildElevenLabsMusicBody(request({ model: 'music_v1', durationSeconds: 3, lyrics: lines(31).join('\n') }))
    ).toThrow('elevenlabs_music_lyrics_too_many_lines_for_duration');
    expect(() => buildElevenLabsMusicBody(request({ durationSeconds: 6, lyrics: lines(59).join('\n') }))).toThrow(
      ElevenLabsPlanError
    );
    expect(
      chunksOf(buildElevenLabsMusicBody(request({ durationSeconds: 6, lyrics: lines(58).join('\n') })))
    ).toHaveLength(2);
  });
});

describe('parseMultipart', () => {
  it('splits a CRLF multipart body without corrupting binary audio', () => {
    const parts = parseMultipart(
      multipart(BOUNDARY, [
        { contentType: 'application/json', body: '{"a":1}' },
        { contentType: 'audio/mpeg', body: AUDIO },
      ]),
      BOUNDARY
    );

    expect(parts?.map(part => part.contentType)).toEqual(['application/json', 'audio/mpeg']);
    expect(parts?.[0].body.toString('utf8')).toBe('{"a":1}');
    expect(parts?.[1].body.equals(AUDIO)).toBe(true);
  });

  it('returns undefined for a body that is not the declared multipart', () => {
    expect(parseMultipart(Buffer.from('{"a":1}'), BOUNDARY)).toBeUndefined();
    expect(parseMultipart(Buffer.from(`--${BOUNDARY}\r\nContent-Type: a/b\r\n\r\nno end`), BOUNDARY)).toBeUndefined();
  });

  it('accepts LF-only line endings, a preamble and padding after a delimiter', () => {
    const body = Buffer.concat([
      Buffer.from(`preamble --${BOUNDARY} mention\n--${BOUNDARY} \t\nContent-Type: application/json\n\n{"a":1}\n`),
      Buffer.from(`--${BOUNDARY}\nContent-Type: audio/mpeg\n\n`),
      AUDIO,
      Buffer.from(`\n--${BOUNDARY}--  \nepilogue`),
    ]);

    const parts = parseMultipart(body, BOUNDARY);

    expect(parts?.map(part => part.contentType)).toEqual(['application/json', 'audio/mpeg']);
    expect(parts?.[0].body.toString('utf8')).toBe('{"a":1}');
    expect(parts?.[1].body.equals(AUDIO)).toBe(true);
  });

  it('keeps the whole body of a headerless part, blank lines and all', () => {
    const inner = Buffer.concat([Buffer.from('Content-Type: text/plain\r\n\r\nnot a header'), AUDIO]);
    const parts = parseMultipart(
      Buffer.concat([Buffer.from(`--${BOUNDARY}\r\n\r\n`), inner, Buffer.from(`\r\n--${BOUNDARY}--`)]),
      BOUNDARY
    );

    expect(parts).toHaveLength(1);
    expect(parts?.[0].contentType).toBe('');
    expect(parts?.[0].body.equals(inner)).toBe(true);
  });

  it('keeps a part with no blank line and no header line whole', () => {
    const parts = parseMultipart(Buffer.from(`--${BOUNDARY}\r\nraw\r\n\r\nbytes\r\n--${BOUNDARY}--`), BOUNDARY);

    expect(parts?.[0].body.toString('latin1')).toBe('raw\r\n\r\nbytes');
  });

  it('ignores the boundary text inside a part when it does not open a delimiter line', () => {
    const parts = parseMultipart(
      Buffer.from(`--${BOUNDARY}\r\nContent-Type: a/b\r\n\r\nx --${BOUNDARY}\r\n--${BOUNDARY}x\r\n--${BOUNDARY}--`),
      BOUNDARY
    );

    expect(parts?.[0].body.toString('latin1')).toBe(`x --${BOUNDARY}\r\n--${BOUNDARY}x`);
  });
});

describe('boundaryOf', () => {
  it('reads a quoted or bare boundary param', () => {
    expect(boundaryOf('multipart/mixed; boundary="a b;c"')).toBe('a b;c');
    expect(boundaryOf('multipart/mixed;boundary=abc; charset=x')).toBe('abc');
    expect(boundaryOf('Multipart/Mixed; BOUNDARY=abc')).toBe('abc');
  });

  it('matches only a real boundary param on a multipart type', () => {
    expect(boundaryOf('multipart/mixed; xboundary=wrong; boundary=right')).toBe('right');
    expect(boundaryOf('multipart/mixed; xboundary=wrong')).toBeUndefined();
    expect(boundaryOf('application/json; boundary=abc')).toBeUndefined();
    expect(boundaryOf(null)).toBeUndefined();
  });
});

describe('lyricsFromPlan', () => {
  it('reads v2 chunks without their section tag, a blank line between chunks', () => {
    expect(
      lyricsFromPlan({ chunks: [{ text: '[Intro]' }, { text: '[Verse]\nOne\nTwo' }, { text: 'Three\n\n' }] })
    ).toBe('One\nTwo\n\nThree');
  });

  it('reads v1 section lines', () => {
    expect(lyricsFromPlan({ sections: [{ lines: ['One', ' '] }, { lines: [] }, { lines: ['Two'] }] })).toBe(
      'One\n\nTwo'
    );
  });

  it('returns undefined for a plan with no lines', () => {
    expect(lyricsFromPlan({ chunks: [{ text: '[Intro]' }] })).toBeUndefined();
    expect(lyricsFromPlan(undefined)).toBeUndefined();
  });
});

describe('ElevenLabsMusicProvider', () => {
  it('makes one call with the key, mp3 output format and built body', async () => {
    const lyrics = '[Verse]\nOne\n[Chorus]\nTwo';
    await generateWith(FIXTURES.succeeds, { lyrics });

    expect(seen).toEqual([
      {
        key: KEY,
        url: `${MUSIC}?output_format=mp3_44100_128`,
        body: buildElevenLabsMusicBody(request({ lyrics })),
      },
    ]);
  });

  it('returns the audio inline with the lyrics from the returned plan and the duration read from the audio', async () => {
    const result = await generateWith(FIXTURES.succeeds);

    expect(result).toMatchObject({
      status: 'succeeded',
      output: { kind: 'inline', base64: AUDIO.toString('base64'), contentType: 'audio/mpeg' },
      lyrics:
        'Morning light on the kitchen floor\nKettle singing by the open door\n\n' +
        'Stay a while, stay a while\nThe day can wait for one more smile',
    });
    if (result.status !== 'succeeded') return;
    expect(result.reportedDurationSeconds).toBeCloseTo(syntheticMp3Seconds(AUDIO_FRAMES), 6);
    expect((await provider.fetchOutput(result.output)).equals(AUDIO)).toBe(true);
  });

  it('reports no lyrics for an instrumental, even when the returned plan has text', async () => {
    const result = await generateWith(FIXTURES.instrumental, { model: 'music_v2', instrumental: true });

    expect(result.status).toBe('succeeded');
    if (result.status === 'succeeded') expect(result.lyrics).toBeUndefined();
  });

  it('reads lyrics from a returned v1 section plan', async () => {
    respondWith(() =>
      multipartResponse([
        {
          contentType: 'application/json',
          body: JSON.stringify({ composition_plan: { sections: [{ lines: ['One'] }] } }),
        },
        { contentType: 'audio/mpeg', body: AUDIO },
      ])
    );

    expect(await provider.generate(request({ model: 'music_v1' }), {}, ctx())).toMatchObject({ lyrics: 'One' });
  });

  it('reports a copyright refusal as blocked with its reason, and not billed', async () => {
    const result = await generateWith(FIXTURES.blocked);

    expect(result).toMatchObject({ status: 'blocked', reason: 'elevenlabs_music_copyrighted_material_detected' });
    expect(result).not.toHaveProperty('billed');
  });

  it('names a refused composition plan by the reason the provider gives', async () => {
    respondWith(() =>
      HttpResponse.json(
        { detail: { status: 'bad_composition_plan', data: { reason: 'Harmful Content' } } },
        { status: 400 }
      )
    );

    expect(await provider.generate(request(), {}, ctx())).toMatchObject({
      status: 'blocked',
      reason: 'elevenlabs_music_harmful_content',
    });
  });

  it.each([
    ['no data', {}],
    ['no reason', { data: {} }],
    ['a non-string reason', { data: { reason: 7 } }],
    ['an overlong reason', { data: { reason: 'x'.repeat(65) } }],
    ['a reason with no word characters', { data: { reason: '!!' } }],
  ])('falls back to the policy reason for a refusal with %s', async (_label, extra) => {
    respondWith(() => HttpResponse.json({ detail: { status: 'bad_prompt', ...extra } }, { status: 400 }));

    expect(await provider.generate(request(), {}, ctx())).toMatchObject({
      status: 'blocked',
      reason: 'elevenlabs_music_policy',
    });
  });

  it('fails a validation 422 without retrying', async () => {
    expect(await generateWith(FIXTURES.fails)).toMatchObject({
      status: 'failed',
      retryable: false,
      message: 'elevenlabs_music_http_422',
    });
  });

  it('names the failure by the provider status when one is given', async () => {
    respondWith(() => HttpResponse.json({ detail: { status: 'quota_exceeded', code: 'x' } }, { status: 401 }));

    expect(await provider.generate(request(), {}, ctx())).toMatchObject({
      retryable: false,
      message: 'elevenlabs_music_quota_exceeded',
    });
  });

  it('lets a throttled call be retried, since nothing was generated', async () => {
    respondWith(() => HttpResponse.json({ detail: { code: 'rate_limited' } }, { status: 429 }));

    expect(await provider.generate(request(), {}, ctx())).toMatchObject({ status: 'failed', retryable: true });
  });

  it('does not retry a 5xx, which may have generated and billed a song', async () => {
    respondWith(() => new HttpResponse('upstream error', { status: 503 }));

    expect(await provider.generate(request(), {}, ctx())).toMatchObject({
      status: 'failed',
      retryable: false,
      message: 'elevenlabs_music_http_503',
      raw: 'upstream error',
    });
  });

  it('fails v1 lyrics that cannot fit before calling the API', async () => {
    const result = await provider.generate(
      request({ model: 'music_v1', durationSeconds: 3, lyrics: lines(31).join('\n') }),
      {},
      ctx()
    );

    expect(result).toMatchObject({ status: 'failed', retryable: false, message: 'elevenlabs_music_lyrics_unfit' });
    expect(seen).toEqual([]);
  });

  it('blocks rather than succeeds when the response carries no audio', async () => {
    respondWith(() => multipartResponse([{ contentType: 'application/json', body: '{"composition_plan":null}' }]));

    expect(await provider.generate(request(), {}, ctx())).toMatchObject({
      status: 'blocked',
      reason: 'elevenlabs_music_no_audio',
    });
  });

  it.each([
    ['unparseable', [{ contentType: 'application/json', body: 'not json' }]],
    ['off-schema', [{ contentType: 'application/json', body: '{"composition_plan":{"chunks":"x"}}' }]],
    ['missing', []],
  ])('keeps the billed audio, without lyrics, when the metadata is %s', async (_label, metadataParts: Part[]) => {
    respondWith(() => multipartResponse([...metadataParts, { contentType: 'audio/mpeg', body: AUDIO }]));
    const context = ctx();
    const warn = vi.spyOn(context.logger, 'warn');

    const result = await provider.generate(request({ lyrics: '[Verse]\nOne' }), {}, context);

    expect(result).toMatchObject({ status: 'succeeded', output: { base64: AUDIO.toString('base64') } });
    expect(result).not.toHaveProperty('lyrics');
    expect(warn).toHaveBeenCalledWith('elevenlabs_music_metadata_unread', expect.anything());
  });

  it('fails a 2xx that is not multipart without retrying', async () => {
    respondWith(() => new HttpResponse(new Uint8Array(AUDIO), { headers: { 'content-type': 'audio/mpeg' } }));

    expect(await provider.generate(request(), {}, ctx())).toMatchObject({ message: 'elevenlabs_music_unparseable' });
  });

  it('does not measure audio that is not MP3', async () => {
    respondWith(() =>
      multipartResponse([
        { contentType: 'application/json', body: '{}' },
        { contentType: 'audio/wav', body: AUDIO },
      ])
    );

    const result = await provider.generate(request(), {}, ctx());

    expect(result).toMatchObject({ status: 'succeeded', output: { contentType: 'audio/wav' } });
    expect(result).not.toHaveProperty('reportedDurationSeconds');
  });

  it('refuses a response larger than the output cap allows', async () => {
    const declared = String(MAX_MUSIC_OUTPUT_BYTES + 2 * 1024 * 1024);
    respondWith(() => new HttpResponse('{}', { headers: { 'content-length': declared } }));

    await expect(provider.generate(request(), {}, ctx())).rejects.toBeInstanceOf(ProviderOutputTooLargeError);
  });

  it('treats a body cut off mid-read as an unknown outcome, like a failed request', async () => {
    respondWith(
      () =>
        new HttpResponse(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`--${BOUNDARY}\r\nContent-Type: application/json\r\n\r\n{`));
              controller.error(new Error('connection reset'));
            },
          }),
          { headers: { 'content-type': `multipart/mixed; boundary=${BOUNDARY}` } }
        )
    );

    const error = await provider.generate(request(), {}, ctx()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderSubmitError);
    expect(error).toMatchObject({ definitive: false, message: 'elevenlabs_music_transport' });
  });

  it('treats an error body cut off mid-read as an unknown outcome', async () => {
    respondWith(
      () =>
        new HttpResponse(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"detail":'));
              controller.error(new Error('connection reset'));
            },
          }),
          { status: 503, headers: { 'content-type': 'application/json' } }
        )
    );

    const error = await provider.generate(request(), {}, ctx()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderSubmitError);
    expect(error).toMatchObject({ definitive: false, message: 'elevenlabs_music_transport' });
  });

  it('caps how much of an error body it reads', async () => {
    respondWith(() => new HttpResponse('{}', { status: 500, headers: { 'content-length': String(70 * 1024) } }));

    expect(await provider.generate(request(), {}, ctx())).toMatchObject({
      status: 'failed',
      message: 'elevenlabs_music_http_500',
      raw: 'elevenlabs_music_error_body_over_65536_bytes',
    });
  });

  it('throws on a transport error: the song may exist, so the job must not call again', async () => {
    respondWith(() => HttpResponse.error());

    const error = await provider.generate(request(), {}, ctx()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderSubmitError);
    expect(error).toMatchObject({ definitive: false, message: 'elevenlabs_music_transport' });
  });

  it('refuses url output, which this provider never produces', async () => {
    await expect(provider.fetchOutput({ kind: 'url', url: `${MUSIC}/x`, requiresAuth: true })).rejects.toThrow(
      'elevenlabs_music_unexpected_url_output'
    );
  });
});
