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
        resolveTtsProvider: vi.fn(),
        assertTtsCreditsAvailable: vi.fn(),
        deductTtsCredits: vi.fn(),
        synthesize: vi.fn(),
        exceedsTtsResponseLimit: vi.fn(),
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

vi.mock('@bike4mind/utils', () => ({
  aiVoiceService: () => ({ synthesize: (...a: unknown[]) => mocks.synthesize(...a) }),
}));

vi.mock('@server/utils/resolveTtsProvider', () => ({
  resolveTtsProvider: (...a: unknown[]) => mocks.resolveTtsProvider(...a),
  TtsProviderNotConfiguredError,
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

import handler from '../tts';

const run = (body: Record<string, unknown>, user: { id?: string } | undefined = { id: 'u1' }) => {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as Record<string, unknown>).user = user;
  (req as Record<string, unknown>).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    res,
    promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res),
  };
};

const okSynthesis = () =>
  mocks.synthesize.mockResolvedValue({
    audio: Buffer.from([1, 2, 3]),
    contentType: 'audio/mpeg',
    format: 'mp3',
    model: 'tts-1',
    characters: 5,
  });

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.resolveTtsProvider.mockResolvedValue({ apiKey: 'key', voice: 'alloy' });
  mocks.assertTtsCreditsAvailable.mockResolvedValue(undefined);
  mocks.deductTtsCredits.mockResolvedValue(undefined);
  mocks.exceedsTtsResponseLimit.mockReturnValue(false);
  okSynthesis();
});

describe('POST /api/ai/tts', () => {
  it('rejects an unsupported (vendor, format) pair with 422 before any provider cost', async () => {
    const { promise } = run({ text: 'hi', provider: 'elevenlabs', format: 'wav' });
    await expect(promise).rejects.toBeInstanceOf(UnprocessableEntityError);
    expect(mocks.resolveTtsProvider).not.toHaveBeenCalled();
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });

  it('returns 401 when the provider is not configured', async () => {
    mocks.resolveTtsProvider.mockRejectedValue(new TtsProviderNotConfiguredError('no key'));
    const { res, promise } = run({ text: 'hi' });
    await promise;
    expect(res._getStatusCode()).toBe(401);
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });

  it('returns 402 and never calls the provider when credits are exhausted', async () => {
    mocks.assertTtsCreditsAvailable.mockRejectedValue(new InsufficientTtsCreditsError('broke'));
    const { res, promise } = run({ text: 'hi' });
    await promise;
    expect(res._getStatusCode()).toBe(402);
    expect(res._getJSONData()).toMatchObject({ provider: 'openai' });
    expect(mocks.synthesize).not.toHaveBeenCalled();
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
    mocks.synthesize.mockRejectedValue({ status: 429, message: 'raw provider detail' });
    const { res, promise } = run({ text: 'hi' });
    await promise;
    expect(res._getStatusCode()).toBe(429);
    const body = res._getJSONData();
    expect(body.error).not.toContain('raw provider detail');
    expect(body).toMatchObject({ provider: 'openai' });
  });

  it('maps a non-4xx provider failure to 502', async () => {
    mocks.synthesize.mockRejectedValue(new Error('network blip'));
    const { res, promise } = run({ text: 'hi' });
    await promise;
    expect(res._getStatusCode()).toBe(502);
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

  it('forwards languageCode to the provider as the language option', async () => {
    const { promise } = run({ text: '2', provider: 'elevenlabs', languageCode: 'en' });
    await promise;
    expect(mocks.synthesize).toHaveBeenCalledWith('2', expect.objectContaining({ language: 'en' }));
  });

  it('passes language as undefined when languageCode is omitted (preserves default behavior)', async () => {
    const { promise } = run({ text: 'hi' });
    await promise;
    expect(mocks.synthesize).toHaveBeenCalledWith('hi', expect.objectContaining({ language: undefined }));
  });

  it('does not bill a caller without a resolved user id', async () => {
    const { promise } = run({ text: 'hi' }, {});
    await promise.catch(() => undefined);
    expect(mocks.assertTtsCreditsAvailable).not.toHaveBeenCalled();
    expect(mocks.deductTtsCredits).not.toHaveBeenCalled();
  });
});
