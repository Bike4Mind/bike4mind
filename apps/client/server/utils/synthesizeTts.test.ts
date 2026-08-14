import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mocks, TtsProviderNotConfiguredError } = vi.hoisted(() => {
  class TtsProviderNotConfiguredError extends Error {}
  return {
    TtsProviderNotConfiguredError,
    mocks: {
      resolveTtsProvider: vi.fn(),
      synthesize: vi.fn(),
      aiVoiceService: vi.fn(),
    },
  };
});

vi.mock('@bike4mind/common', () => ({
  supportedVoiceGenerationVendor: { options: ['openai', 'elevenlabs'] },
  TTS_MAX_INPUT_CHARS: { openai: 4096, elevenlabs: 10000 },
  VOICE_VENDOR_SUPPORTED_FORMATS: { openai: ['mp3', 'wav'], elevenlabs: ['mp3', 'pcm', 'opus'] },
}));

vi.mock('@bike4mind/utils', () => ({
  aiVoiceService: (...a: unknown[]) => {
    mocks.aiVoiceService(...a);
    return { synthesize: (...s: unknown[]) => mocks.synthesize(...s) };
  },
}));

vi.mock('./resolveTtsProvider', () => ({
  resolveTtsProvider: (...a: unknown[]) => mocks.resolveTtsProvider(...a),
  TtsProviderNotConfiguredError,
}));

import { synthesizeTts, upstreamStatus, isCredentialRejection } from './synthesizeTts';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const audio = () => ({
  audio: Buffer.from([1, 2, 3]),
  contentType: 'audio/mpeg',
  format: 'mp3',
  model: 'tts-1',
  characters: 2,
});

const run = (overrides: Record<string, unknown> = {}) =>
  synthesizeTts({
    provider: 'openai',
    text: 'hi',
    userId: 'u1',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any: the test drives partial arg sets through the real signature
    logger: logger as any,
    ...overrides,
  } as Parameters<typeof synthesizeTts>[0]);

// The OpenAI SDK shape; the ElevenLabs (axios) shape nests it under `response`.
const rejection = (status: number) => Object.assign(new Error('upstream said no'), { status });
const axiosRejection = (status: number) => Object.assign(new Error('upstream said no'), { response: { status } });

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  logger.warn.mockReset();
  mocks.resolveTtsProvider.mockResolvedValue({ apiKey: 'key', voice: 'alloy' });
  mocks.synthesize.mockResolvedValue(audio());
});

describe('upstreamStatus', () => {
  it('reads the SDK shape, the axios shape, and neither', () => {
    expect(upstreamStatus(rejection(429))).toBe(429);
    expect(upstreamStatus(axiosRejection(401))).toBe(401);
    expect(upstreamStatus(new Error('network blip'))).toBeUndefined();
    expect(upstreamStatus(undefined)).toBeUndefined();
  });
});

describe('isCredentialRejection', () => {
  it('is true only for 401/403, in either error shape', () => {
    expect(isCredentialRejection(rejection(401))).toBe(true);
    expect(isCredentialRejection(axiosRejection(403))).toBe(true);
    expect(isCredentialRejection(rejection(400))).toBe(false);
    expect(isCredentialRejection(rejection(429))).toBe(false);
    expect(isCredentialRejection(new Error('network blip'))).toBe(false);
  });
});

describe('synthesizeTts', () => {
  it('uses the requested provider and reports no fallback on success', async () => {
    const out = await run({ requestedVoice: 'nova', model: 'tts-1-hd', format: 'wav' });
    expect(out.vendor).toBe('openai');
    expect(out.fallbackFrom).toBeUndefined();
    expect(mocks.synthesize).toHaveBeenCalledTimes(1);
    expect(mocks.synthesize).toHaveBeenCalledWith(
      'hi',
      expect.objectContaining({ voice: 'alloy', model: 'tts-1-hd', format: 'wav' })
    );
  });

  it('maps languageCode onto the provider language option, defaulting to undefined', async () => {
    await run({ languageCode: 'en' });
    expect(mocks.synthesize).toHaveBeenLastCalledWith('hi', expect.objectContaining({ language: 'en' }));

    await run();
    expect(mocks.synthesize).toHaveBeenLastCalledWith('hi', expect.objectContaining({ language: undefined }));
  });

  it('falls back to another provider when the requested one rejects our credentials', async () => {
    mocks.synthesize.mockRejectedValueOnce(rejection(401)).mockResolvedValueOnce(audio());

    const out = await run();

    expect(out.vendor).toBe('elevenlabs');
    expect(out.fallbackFrom).toBe('openai');
    expect(mocks.aiVoiceService).toHaveBeenNthCalledWith(1, 'openai', 'key', logger);
    expect(mocks.aiVoiceService).toHaveBeenNthCalledWith(2, 'elevenlabs', 'key', logger);
  });

  it('falls back when the requested provider has no key configured at all', async () => {
    mocks.resolveTtsProvider
      .mockRejectedValueOnce(new TtsProviderNotConfiguredError('OpenAI API key not configured'))
      .mockResolvedValueOnce({ apiKey: 'xi-key', voice: 'rachel' });

    const out = await run();

    expect(out).toMatchObject({ vendor: 'elevenlabs', fallbackFrom: 'openai' });
  });

  it('drops the vendor-scoped voice and model when standing in another provider', async () => {
    mocks.synthesize.mockRejectedValueOnce(rejection(401)).mockResolvedValueOnce(audio());

    await run({ requestedVoice: 'nova', model: 'tts-1-hd', preferredVoice: 'echo' });

    // An OpenAI voice name is not a valid ElevenLabs voiceId, so the alternate
    // resolves its own; preferredVoice is OpenAI-scoped inside the resolver and
    // passes through untouched.
    expect(mocks.resolveTtsProvider).toHaveBeenNthCalledWith(2, {
      provider: 'elevenlabs',
      userId: 'u1',
      requestedVoice: undefined,
      preferredVoice: 'echo',
    });
    expect(mocks.synthesize).toHaveBeenNthCalledWith(2, 'hi', expect.objectContaining({ model: undefined }));
  });

  it('drops a format the alternate cannot produce rather than failing on it', async () => {
    mocks.synthesize.mockRejectedValueOnce(rejection(401)).mockResolvedValueOnce(audio());

    await run({ format: 'wav' });

    expect(mocks.synthesize).toHaveBeenNthCalledWith(2, 'hi', expect.objectContaining({ format: undefined }));
  });

  it('keeps a format the alternate does support', async () => {
    mocks.synthesize.mockRejectedValueOnce(rejection(401)).mockResolvedValueOnce(audio());

    await run({ format: 'mp3' });

    expect(mocks.synthesize).toHaveBeenNthCalledWith(2, 'hi', expect.objectContaining({ format: 'mp3' }));
  });

  it('does not consider an alternate whose input ceiling is below the text', async () => {
    const text = 'x'.repeat(5000);
    mocks.synthesize.mockRejectedValue(axiosRejection(401));

    await expect(run({ provider: 'elevenlabs', text })).rejects.toMatchObject({ response: { status: 401 } });
    // openai caps at 4096, so it was never a real alternate for this text.
    expect(mocks.synthesize).toHaveBeenCalledTimes(1);
  });

  it('never retries elsewhere for a request-shaped failure', async () => {
    mocks.synthesize.mockRejectedValue(rejection(400));

    await expect(run()).rejects.toMatchObject({ status: 400 });
    expect(mocks.synthesize).toHaveBeenCalledTimes(1);
  });

  it('never retries elsewhere for a rate limit', async () => {
    mocks.synthesize.mockRejectedValue(rejection(429));

    await expect(run()).rejects.toMatchObject({ status: 429 });
    expect(mocks.synthesize).toHaveBeenCalledTimes(1);
  });

  it('reports the requested provider error when every candidate is unusable', async () => {
    mocks.synthesize.mockRejectedValueOnce(rejection(401)).mockRejectedValueOnce(rejection(403));

    await expect(run()).rejects.toMatchObject({ status: 401 });
    expect(mocks.synthesize).toHaveBeenCalledTimes(2);
  });

  it('reports the requested provider error when the alternate fails for its own reason', async () => {
    mocks.resolveTtsProvider
      .mockRejectedValueOnce(new TtsProviderNotConfiguredError('OpenAI API key not configured'))
      .mockResolvedValueOnce({ apiKey: 'xi-key', voice: 'rachel' });
    mocks.synthesize.mockRejectedValueOnce(rejection(400));

    await expect(run()).rejects.toBeInstanceOf(TtsProviderNotConfiguredError);
  });

  it('logs every unusable provider so the operator sees which keys are failing', async () => {
    mocks.synthesize.mockRejectedValueOnce(rejection(401)).mockResolvedValueOnce(audio());

    await run();

    expect(logger.warn).toHaveBeenCalledWith(
      'TTS provider unusable',
      expect.objectContaining({ vendor: 'openai', error: 'upstream said no' })
    );
  });
});
