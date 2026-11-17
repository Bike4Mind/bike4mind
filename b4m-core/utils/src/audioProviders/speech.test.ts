import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { VoiceGenerationVendor } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { describeSyncProviderConformance, type SyncConformanceScenario } from '../generationProviders/conformance';
import type { ProviderContext } from '../generationProviders/types';
import { isCredentialRejectionResult } from './errors';
import { createSpeechProvider, type SpeechProviderRequest } from './speech';
import { testSpeechProvider } from './test';

const OPENAI_SPEECH = 'https://api.openai.com/v1/audio/speech';
const ELEVENLABS_SPEECH = 'https://api.elevenlabs.io/v1/text-to-speech/:voiceId';
const AUDIO = Buffer.from([0xff, 0xfb, 0x14, 0xc0, 1, 2, 3, 4]);
// Stops the OpenAI SDK's own retry loop from slowing the error cases down.
const NO_SDK_RETRY = { 'retry-after-ms': '1', 'x-should-retry': 'false' };

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const context = (overrides: Partial<ProviderContext> = {}): ProviderContext => ({
  apiKey: 'test-key',
  logger: new Logger({ metadata: { suite: 'speech' } }),
  now: () => new Date(),
  signal: new AbortController().signal,
  ...overrides,
});

const request = (text = 'Hello there'): SpeechProviderRequest => ({ text });

const audioResponse = () => new HttpResponse(new Uint8Array(AUDIO), { headers: { 'content-type': 'audio/mpeg' } });

const openAiError = (status: number, body: Record<string, unknown>) =>
  HttpResponse.json({ error: body }, { status, headers: NO_SDK_RETRY });

const armOpenAi = (name: SyncConformanceScenario) => {
  server.use(
    http.post(OPENAI_SPEECH, () => {
      if (name === 'succeeds') return audioResponse();
      if (name === 'blocked') return openAiError(400, { code: 'content_policy_violation', message: 'refused' });
      return openAiError(400, { code: 'invalid_value', message: 'bad voice' });
    })
  );
  return request();
};

const armElevenLabs = (name: SyncConformanceScenario) => {
  server.use(
    http.post(ELEVENLABS_SPEECH, () => {
      if (name === 'succeeds') return audioResponse();
      if (name === 'blocked') {
        return HttpResponse.json({ detail: { status: 'content_policy_violation', message: 'no' } }, { status: 400 });
      }
      return HttpResponse.json({ detail: { status: 'invalid_parameters', message: 'bad' } }, { status: 422 });
    })
  );
  return request();
};

describeSyncProviderConformance('OpenAI speech provider', {
  provider: () => createSpeechProvider('openai'),
  scenario: armOpenAi,
});

describeSyncProviderConformance('ElevenLabs speech provider', {
  provider: () => createSpeechProvider('elevenlabs'),
  scenario: armElevenLabs,
});

describeSyncProviderConformance('test speech provider', {
  provider: () => testSpeechProvider,
  scenario: name => request({ succeeds: 'hello', blocked: '[blocked]', fails: '[fail]' }[name]),
});

describe('speech provider', () => {
  it('returns the audio inline with the format content type', async () => {
    armElevenLabs('succeeds');
    const result = await createSpeechProvider('elevenlabs').generate(request(), {}, context());
    expect(result).toEqual({
      status: 'succeeded',
      output: { kind: 'inline', base64: AUDIO.toString('base64'), contentType: 'audio/mpeg' },
    });
  });

  it('lists the vendor default model among its models', () => {
    expect(createSpeechProvider('openai').models).toContain('gpt-4o-mini-tts');
    expect(createSpeechProvider('elevenlabs').models).toContain('eleven_multilingual_v2');
  });

  it('decodes inline output and refuses a url output', async () => {
    const provider = createSpeechProvider('openai');
    const bytes = await provider.fetchOutput(
      { kind: 'inline', base64: AUDIO.toString('base64'), contentType: 'x' },
      context()
    );
    expect(bytes.equals(AUDIO)).toBe(true);
    await expect(
      provider.fetchOutput({ kind: 'url', url: 'https://x.test/a.mp3' } as never, context())
    ).rejects.toThrow();
  });

  describe.each<[VoiceGenerationVendor, (status: number) => void]>([
    [
      'openai',
      status => server.use(http.post(OPENAI_SPEECH, () => openAiError(status, { message: 'upstream', code: 'x' }))),
    ],
    [
      'elevenlabs',
      status => server.use(http.post(ELEVENLABS_SPEECH, () => HttpResponse.json({ detail: 'upstream' }, { status }))),
    ],
  ])('%s error mapping', (vendor, respondWith) => {
    const generate = () => createSpeechProvider(vendor).generate(request(), {}, context());

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

    it('maps another 4xx to a non-retryable failure that is not a credential rejection', async () => {
      respondWith(404);
      const result = await generate();
      expect(result).toMatchObject({ status: 'failed', retryable: false });
      expect(isCredentialRejectionResult(result)).toBe(false);
    });

    it('rethrows a 5xx because the outcome is unknown', async () => {
      respondWith(503);
      await expect(generate()).rejects.toBeDefined();
    });

    it('rethrows a network error', async () => {
      server.use(
        http.post(OPENAI_SPEECH, () => HttpResponse.error()),
        http.post(ELEVENLABS_SPEECH, () => HttpResponse.error())
      );
      await expect(generate()).rejects.toBeDefined();
    });

    it('rethrows an aborted call', async () => {
      respondWith(200);
      const controller = new AbortController();
      controller.abort();
      await expect(
        createSpeechProvider(vendor).generate(request(), {}, context({ signal: controller.signal }))
      ).rejects.toBeDefined();
    });
  });

  it('does not read a policy block from a caller voice id echoed in the error message', async () => {
    const result = await createSpeechProvider('elevenlabs').generate(
      { ...request(), voice: 'prohibited content violates.policy' },
      {},
      context()
    );
    expect(result).toMatchObject({ status: 'failed', retryable: false, message: 'elevenlabs_speech_http_422' });
  });

  it('bounds the provider text kept on a failure', async () => {
    server.use(http.post(ELEVENLABS_SPEECH, () => HttpResponse.json({ detail: 'x'.repeat(5000) }, { status: 400 })));
    const result = await createSpeechProvider('elevenlabs').generate(request(), {}, context());
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(JSON.stringify(result.raw).length).toBeLessThan(400);
    expect(result.message.length).toBeLessThan(60);
  });
});
