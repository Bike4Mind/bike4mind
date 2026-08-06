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
        exceedsTtsResponseLimit: vi.fn(),
        persistGeneratedAudio: vi.fn(),
      },
    };
  }
);

// baseApi mock: unwrap the post handler (same shape as the rotate-token test).
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (fn: unknown) => fn }),
}));

vi.mock('@bike4mind/common', () => ({
  UnprocessableEntityError,
  // Passthrough parse: schema validation is covered by the common package; here
  // we drive the well-formed body straight through to exercise the route logic.
  ttsRequestSchema: { parse: (b: unknown) => b },
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
vi.mock('@server/utils/ttsResponseLimit', () => ({
  exceedsTtsResponseLimit: (...a: unknown[]) => mocks.exceedsTtsResponseLimit(...a),
  TTS_RESPONSE_TOO_LARGE_MESSAGE: 'too large',
}));
// Mock the persistence helper so this route test doesn't pull in the real
// FabFile/services/database stack (which references @bike4mind/common exports
// not provided by the partial mock above).
vi.mock('@server/utils/persistGeneratedAudio', () => ({
  persistGeneratedAudio: (...a: unknown[]) => mocks.persistGeneratedAudio(...a),
}));

import handler from '../tts';

const run = (
  body: Record<string, unknown>,
  user: { id?: string; preferences?: { saveGeneratedAudio?: boolean } } | undefined = { id: 'u1' }
) => {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as Record<string, unknown>).user = user;
  (req as Record<string, unknown>).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    res,
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
  mocks.exceedsTtsResponseLimit.mockReturnValue(false);
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

  it('returns 402 and never calls the provider when credits are exhausted', async () => {
    mocks.assertTtsCreditsAvailable.mockRejectedValue(new InsufficientTtsCreditsError('broke'));
    const { res, promise } = run({ text: 'hi' });
    await promise;
    expect(res._getStatusCode()).toBe(402);
    expect(res._getJSONData()).toMatchObject({ provider: 'openai' });
    expect(mocks.synthesizeTts).not.toHaveBeenCalled();
  });

  it('bills for the synthesis before the size guard, then returns 413 when the audio is too large', async () => {
    mocks.exceedsTtsResponseLimit.mockReturnValue(true);
    const { res, promise } = run({ text: 'hi' });
    await promise;
    expect(res._getStatusCode()).toBe(413);
    // Provider cost is already incurred, so we must still charge on an oversized result.
    expect(mocks.deductTtsCredits).toHaveBeenCalledTimes(1);
  });

  it('passes an upstream 4xx through with a generic body, without leaking provider text', async () => {
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
