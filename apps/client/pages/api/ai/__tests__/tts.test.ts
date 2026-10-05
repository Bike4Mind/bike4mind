import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mocks, InsufficientTtsCreditsError, TtsProviderNotConfiguredError, UnprocessableEntityError } = vi.hoisted(
  () => {
    class InsufficientTtsCreditsError extends Error {}
    class TtsProviderNotConfiguredError extends Error {}
    class UnprocessableEntityError extends Error {}
    return {
      InsufficientTtsCreditsError,
      TtsProviderNotConfiguredError,
      UnprocessableEntityError,
      mocks: {
        synthesizeTts: vi.fn(),
        assertTtsCreditsAvailable: vi.fn(),
        deductTtsCredits: vi.fn(),
        persistGeneratedAudio: vi.fn(),
        upload: vi.fn(),
        getSignedUrl: vi.fn(),
      },
    };
  }
);

// Contract-adapter mock: unwrap the post handler and stand in for the prelude by
// exposing the body as `req.validated`. Passthrough, not a real parse - schema
// validation is covered by the common package; here the well-formed body is
// driven straight through to exercise the route logic.
vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: () => ({
    post:
      (fn: (req: Record<string, unknown>, res: unknown) => unknown) => (req: Record<string, unknown>, res: unknown) => {
        req.validated = req.body;
        return fn(req, res);
      },
  }),
}));

// Real common (shouldPersistGeneratedAudio, extensionFromMimeType) with the TTS tables pinned.
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  UnprocessableEntityError,
  DEFAULT_TTS_PROVIDER: 'openai',
  synthesizeSpeechContract: { method: 'post', path: '/api/ai/tts', auth: 'apiKeyOrJwt', responses: {} },
  TTS_MAX_INPUT_CHARS: { openai: 4096, elevenlabs: 10000 },
  VOICE_VENDOR_SUPPORTED_FORMATS: { openai: ['mp3', 'wav'], elevenlabs: ['mp3', 'pcm', 'opus'] },
}));

vi.mock('@server/utils/resolveTtsProvider', () => ({
  TtsProviderNotConfiguredError,
}));
// The provider-selection + fallback loop is covered in synthesizeTts.test.ts;
// here it is a seam so the route's own branching is what's under test.
vi.mock('@server/utils/synthesizeTts', () => ({
  synthesizeTts: (...a: unknown[]) => mocks.synthesizeTts(...a),
  upstreamStatus: (error: unknown) => (error as { status?: number })?.status,
  isCredentialRejection: (error: unknown) => {
    const status = (error as { status?: number })?.status;
    return status === 401 || status === 403;
  },
}));
vi.mock('@server/utils/deductTtsCredits', () => ({
  assertTtsCreditsAvailable: (...a: unknown[]) => mocks.assertTtsCreditsAvailable(...a),
  deductTtsCredits: (...a: unknown[]) => mocks.deductTtsCredits(...a),
  InsufficientTtsCreditsError,
}));
// Mock the persistence helper so this route test doesn't pull in the real
// FabFile/services/database stack (which references @bike4mind/common exports
// not provided by the partial mock above).
vi.mock('@server/utils/persistGeneratedAudio', () => ({
  persistGeneratedAudio: (...a: unknown[]) => mocks.persistGeneratedAudio(...a),
}));

// Only the oversized-audio offload touches storage; the delivery module itself is real.
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({
    upload: (...a: unknown[]) => mocks.upload(...a),
    getSignedUrl: (...a: unknown[]) => mocks.getSignedUrl(...a),
  }),
}));

import { GENERATED_AUDIO_TOO_LARGE_MESSAGE } from '@server/utils/generatedAudioDelivery';
import handler from '../tts';

const run = (
  body: Record<string, unknown>,
  user: { id?: string; preferences?: { saveGeneratedAudio?: boolean } } | undefined = { id: 'u1' }
) => {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as Record<string, unknown>).user = user;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  (req as Record<string, unknown>).logger = logger;
  return {
    res,
    logger,
    promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res),
  };
};

const synthesisResult = () => ({
  audio: Buffer.from([1, 2, 3]),
  contentType: 'audio/mpeg',
  format: 'mp3',
  model: 'tts-1',
  characters: 5,
});

const okSynthesis = (vendor = 'openai', fallbackFrom?: string) =>
  mocks.synthesizeTts.mockResolvedValue({ vendor, result: synthesisResult(), fallbackFrom });

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.assertTtsCreditsAvailable.mockResolvedValue(undefined);
  mocks.deductTtsCredits.mockResolvedValue(undefined);
  mocks.upload.mockResolvedValue(undefined);
  mocks.getSignedUrl.mockResolvedValue('https://s3/offload');
  mocks.persistGeneratedAudio.mockResolvedValue({
    saved: true,
    fabFileId: 'fab-1',
    fileName: 'speech-1.mp3',
    fileUrl: 'https://s3/get',
  });
  okSynthesis();
});

describe('POST /api/ai/tts', () => {
  it('rejects an unsupported (vendor, format) pair with 422 before any provider cost', async () => {
    const { promise } = run({ text: 'hi', provider: 'elevenlabs', format: 'wav' });
    await expect(promise).rejects.toBeInstanceOf(UnprocessableEntityError);
    expect(mocks.synthesizeTts).not.toHaveBeenCalled();
  });

  it('returns 401 with an actionable code when no provider is configured', async () => {
    mocks.synthesizeTts.mockRejectedValue(new TtsProviderNotConfiguredError('no key'));
    const { res, promise } = run({ text: 'hi' });
    await promise;
    expect(res._getStatusCode()).toBe(401);
    expect(res._getJSONData()).toMatchObject({ error: 'no key', errorCode: 'provider_not_configured' });
  });

  // 422 + `insufficient_credits`, matching every other credit-metered endpoint.
  // The classifier is the load-bearing half: this 422 shares its status with an
  // ordinary validation failure, so a caller that matched on the status alone
  // would treat "out of credits" as "bad request".
  it('returns a classified 422 and never calls the provider when credits are exhausted', async () => {
    mocks.assertTtsCreditsAvailable.mockRejectedValue(new InsufficientTtsCreditsError('broke'));
    const { res, promise } = run({ text: 'hi' });
    await promise;
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData()).toMatchObject({
      error: 'broke',
      provider: 'openai',
      errorCode: 'insufficient_credits',
    });
    expect(mocks.synthesizeTts).not.toHaveBeenCalled();
  });

  describe('audio over the response limit', () => {
    const oversizedAudio = Buffer.alloc(4 * 1024 * 1024 + 1);

    beforeEach(() => {
      mocks.synthesizeTts.mockResolvedValue({
        vendor: 'openai',
        result: { ...synthesisResult(), audio: oversizedAudio },
      });
    });

    it('serves the saved copy by URL for base64, without offloading, and still bills once', async () => {
      const { res, promise } = run({ text: 'hi', encoding: 'base64' });
      await promise;
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData()).toMatchObject({
        delivery: 'url',
        url: 'https://s3/get',
        bytes: oversizedAudio.length,
        saved: true,
        fabFileId: 'fab-1',
      });
      expect(mocks.upload).not.toHaveBeenCalled();
      // Provider cost is already incurred, so we must still charge on an oversized result.
      expect(mocks.deductTtsCredits).toHaveBeenCalledTimes(1);
    });

    it('offloads an unsaved binary response and redirects with a 303', async () => {
      const { res, promise } = run({ text: 'hi', preview: true });
      await promise;
      expect(mocks.persistGeneratedAudio).not.toHaveBeenCalled();
      expect(mocks.upload).toHaveBeenCalledWith(
        oversizedAudio,
        expect.stringMatching(/^generated-audio-offload\/.+\.mp3$/),
        { ContentType: 'audio/mpeg' }
      );
      expect(res._getStatusCode()).toBe(303);
      expect(res._getRedirectUrl()).toBe('https://s3/offload');
    });

    it('returns a 413 with the provider and logs when the offload fails', async () => {
      mocks.upload.mockRejectedValue(new Error('s3 down'));
      const { res, logger, promise } = run({ text: 'hi', preview: true, encoding: 'base64' });
      await promise;
      expect(res._getStatusCode()).toBe(413);
      expect(res._getJSONData()).toEqual({ error: GENERATED_AUDIO_TOO_LARGE_MESSAGE, provider: 'openai' });
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(mocks.deductTtsCredits).toHaveBeenCalledTimes(1);
    });
  });

  it('sets the save headers on a binary response when the audio was saved', async () => {
    const { res, promise } = run({ text: 'hi' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('X-B4M-Audio-Saved')).toBe('true');
    expect(res.getHeader('X-B4M-Audio-File-Name')).toBe('speech-1.mp3');
    expect(res.getHeader('X-B4M-Audio-File-Url')).toBe('https://s3/get');
  });

  it('passes an upstream 429 through with a generic body, without leaking provider text', async () => {
    mocks.synthesizeTts.mockRejectedValue({ status: 429, message: 'raw provider detail' });
    const { res, promise } = run({ text: 'hi' });
    await promise;
    expect(res._getStatusCode()).toBe(429);
    const body = res._getJSONData();
    expect(body.error).not.toContain('raw provider detail');
    expect(body).toMatchObject({ provider: 'openai' });
    // A rate limit is not a credential problem, so no switch-provider hint.
    expect(body.errorCode).toBeUndefined();
  });

  it('flags a credential rejection so the client can advise switching provider', async () => {
    mocks.synthesizeTts.mockRejectedValue({ status: 401, message: 'raw provider detail' });
    const { res, promise } = run({ text: 'hi' });
    await promise;
    expect(res._getStatusCode()).toBe(401);
    const body = res._getJSONData();
    expect(body.error).not.toContain('raw provider detail');
    expect(body).toMatchObject({ provider: 'openai', errorCode: 'provider_rejected' });
  });

  // The contract documents 401/422/429 only, so a raw provider 400/403/404 must
  // not reach the caller as-is.
  it.each([
    { upstream: 403, expected: 401, errorCode: 'provider_rejected' },
    { upstream: 400, expected: 422, errorCode: undefined },
    { upstream: 404, expected: 422, errorCode: undefined },
    { upstream: 413, expected: 422, errorCode: undefined },
  ])('maps an upstream $upstream onto the documented $expected', async ({ upstream, expected, errorCode }) => {
    mocks.synthesizeTts.mockRejectedValue({ status: upstream, message: 'raw provider detail' });
    const { res, promise } = run({ text: 'hi' });
    await promise;
    expect(res._getStatusCode()).toBe(expected);
    const body = res._getJSONData();
    expect(body.error).not.toContain('raw provider detail');
    expect(body.errorCode).toBe(errorCode);
  });

  it('maps a non-4xx provider failure to 502', async () => {
    mocks.synthesizeTts.mockRejectedValue(new Error('network blip'));
    const { res, promise } = run({ text: 'hi' });
    await promise;
    expect(res._getStatusCode()).toBe(502);
  });

  it('reports a substituted provider in the body and headers, and bills the vendor that did the work', async () => {
    okSynthesis('elevenlabs', 'openai');
    const { res, promise } = run({ text: 'hi', encoding: 'base64' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ provider: 'elevenlabs', fallbackFrom: 'openai' });
    expect(res.getHeader('X-B4M-Tts-Provider')).toBe('elevenlabs');
    expect(res.getHeader('X-B4M-Tts-Provider-Fallback-From')).toBe('openai');
    expect(mocks.deductTtsCredits).toHaveBeenCalledWith(expect.objectContaining({ vendor: 'elevenlabs' }));
  });

  it('omits the substitution fields when the requested provider was used', async () => {
    const { res, promise } = run({ text: 'hi', encoding: 'base64' });
    await promise;
    const body = res._getJSONData();
    expect(body.provider).toBeUndefined();
    expect(body.fallbackFrom).toBeUndefined();
    expect(res.getHeader('X-B4M-Tts-Provider')).toBeUndefined();
  });

  it('returns base64 JSON when encoding is base64 and charges once', async () => {
    const { res, promise } = run({ text: 'hello', encoding: 'base64' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({
      delivery: 'inline',
      audio: Buffer.from([1, 2, 3]).toString('base64'),
      format: 'mp3',
      contentType: 'audio/mpeg',
    });
    expect(mocks.deductTtsCredits).toHaveBeenCalledTimes(1);
  });

  it('forwards the request options for synthesis', async () => {
    const { promise } = run({ text: '2', provider: 'elevenlabs', languageCode: 'en', voice: 'v1' });
    await promise;
    expect(mocks.synthesizeTts).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'elevenlabs', text: '2', languageCode: 'en', requestedVoice: 'v1' })
    );
  });

  it('does not bill a caller without a resolved user id', async () => {
    const { promise } = run({ text: 'hi' }, {});
    await promise.catch(() => undefined);
    expect(mocks.assertTtsCreditsAvailable).not.toHaveBeenCalled();
    expect(mocks.deductTtsCredits).not.toHaveBeenCalled();
  });

  it('persists the audio by default and surfaces the saved reference in the base64 body', async () => {
    const { res, promise } = run({ text: 'hello', encoding: 'base64' });
    await promise;
    expect(mocks.persistGeneratedAudio).toHaveBeenCalledTimes(1);
    expect(mocks.persistGeneratedAudio).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', source: 'tts' }));
    expect(res._getJSONData()).toMatchObject({ saved: true, fabFileId: 'fab-1', fileUrl: 'https://s3/get' });
  });

  it('skips persistence for a throwaway preview (preview: true)', async () => {
    const { res, promise } = run({ text: 'hi', preview: true });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.persistGeneratedAudio).not.toHaveBeenCalled();
  });

  it('skips persistence when the user opted out (saveGeneratedAudio: false)', async () => {
    const { promise } = run({ text: 'hi' }, { id: 'u1', preferences: { saveGeneratedAudio: false } });
    await promise;
    expect(mocks.persistGeneratedAudio).not.toHaveBeenCalled();
  });
});
