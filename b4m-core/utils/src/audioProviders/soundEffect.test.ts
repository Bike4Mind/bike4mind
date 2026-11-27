import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { Logger } from '@bike4mind/observability';
import { describeSyncProviderConformance, type SyncConformanceScenario } from '../generationProviders/conformance';
import type { ProviderContext } from '../generationProviders/types';
import { isCredentialRejectionResult } from './errors';
import { createSoundEffectProvider, type SoundEffectProviderRequest } from './soundEffect';
import { testSoundEffectProvider } from './test';

const SOUND_GENERATION = 'https://api.elevenlabs.io/v1/sound-generation';
const AUDIO = Buffer.from([0xff, 0xfb, 0x14, 0xc0, 1, 2, 3, 4]);

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const context = (overrides: Partial<ProviderContext> = {}): ProviderContext => ({
  apiKey: 'test-key',
  logger: new Logger({ metadata: { suite: 'soundEffect' } }),
  now: () => new Date(),
  signal: new AbortController().signal,
  ...overrides,
});

const request = (text = 'A door slams'): SoundEffectProviderRequest => ({ text });

const respondWith = (status: number, body: unknown = { detail: 'upstream' }, headers: Record<string, string> = {}) =>
  server.use(
    http.post(SOUND_GENERATION, () => HttpResponse.json(body as Record<string, unknown>, { status, headers }))
  );

const arm = (name: SyncConformanceScenario) => {
  if (name === 'succeeds') {
    server.use(
      http.post(
        SOUND_GENERATION,
        () => new HttpResponse(new Uint8Array(AUDIO), { headers: { 'content-type': 'audio/mpeg' } })
      )
    );
  } else if (name === 'blocked') {
    respondWith(400, { detail: { status: 'content_policy_violation', message: 'no' } });
  } else {
    respondWith(422, { detail: { status: 'invalid_parameters', message: 'bad' } });
  }
  return request();
};

describeSyncProviderConformance('ElevenLabs sound effect provider', {
  provider: () => createSoundEffectProvider('elevenlabs'),
  scenario: arm,
});

describeSyncProviderConformance('test sound effect provider', {
  provider: () => testSoundEffectProvider,
  scenario: name => request({ succeeds: 'a door', blocked: '[blocked]', fails: '[fail]' }[name]),
});

describe('sound effect provider', () => {
  const generate = () => createSoundEffectProvider('elevenlabs').generate(request(), {}, context());

  it('returns the audio inline with the format content type', async () => {
    arm('succeeds');
    expect(await generate()).toEqual({
      status: 'succeeded',
      output: { kind: 'inline', base64: AUDIO.toString('base64'), contentType: 'audio/mpeg' },
    });
  });

  it('lists the sound model', () => {
    expect(createSoundEffectProvider('elevenlabs').models).toEqual(['eleven_text_to_sound_v2']);
  });

  it('maps a 429 to a retryable failure', async () => {
    respondWith(429);
    await expect(generate()).resolves.toMatchObject({ status: 'failed', retryable: true });
  });

  it.each([401, 403])('maps a %i to a non-retryable credential rejection', async status => {
    respondWith(status);
    const result = await generate();
    expect(result).toMatchObject({ status: 'failed', retryable: false, raw: { status } });
    expect(isCredentialRejectionResult(result)).toBe(true);
  });

  it('maps another 4xx to a non-retryable failure', async () => {
    respondWith(404);
    const result = await generate();
    expect(result).toMatchObject({ status: 'failed', retryable: false });
    expect(isCredentialRejectionResult(result)).toBe(false);
  });

  it('rethrows a 5xx because the outcome is unknown', async () => {
    respondWith(502);
    await expect(generate()).rejects.toBeDefined();
  });

  it('rethrows a network error', async () => {
    server.use(http.post(SOUND_GENERATION, () => HttpResponse.error()));
    await expect(generate()).rejects.toBeDefined();
  });

  it('rethrows an aborted call', async () => {
    arm('succeeds');
    const controller = new AbortController();
    controller.abort();
    await expect(
      createSoundEffectProvider('elevenlabs').generate(request(), {}, context({ signal: controller.signal }))
    ).rejects.toBeDefined();
  });

  it('decodes inline output and refuses a url output', async () => {
    const provider = createSoundEffectProvider('elevenlabs');
    const bytes = await provider.fetchOutput(
      { kind: 'inline', base64: AUDIO.toString('base64'), contentType: 'x' },
      context()
    );
    expect(bytes.equals(AUDIO)).toBe(true);
    await expect(
      provider.fetchOutput({ kind: 'url', url: 'https://x.test/a.mp3' } as never, context())
    ).rejects.toThrow();
  });
});
