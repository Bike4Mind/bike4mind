import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mocks, InsufficientCreditsPreflightError, TtsProviderNotConfiguredError } = vi.hoisted(() => {
  class InsufficientCreditsPreflightError extends Error {}
  class TtsProviderNotConfiguredError extends Error {}
  return {
    InsufficientCreditsPreflightError,
    TtsProviderNotConfiguredError,
    mocks: {
      synthesize: vi.fn(),
      resolveTtsProvider: vi.fn(),
      assertPreflightCredits: vi.fn(),
      estimateTtsCreditCost: vi.fn(),
      deductTtsCredits: vi.fn(),
      upload: vi.fn(),
      getSignedUrl: vi.fn(),
    },
  };
});

// Passthrough: the real baseApi/asyncHandler pull in auth/db middleware; here the
// handler is driven directly with req.user/req.logger set by the test.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (fn: unknown) => fn }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: unknown) => fn,
}));
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  estimateTtsCreditCost: (...a: unknown[]) => mocks.estimateTtsCreditCost(...a),
}));
vi.mock('@bike4mind/utils', () => ({
  aiVoiceService: () => ({ synthesize: (...a: unknown[]) => mocks.synthesize(...a) }),
}));
vi.mock('@server/utils/resolveTtsProvider', () => ({
  resolveTtsProvider: (...a: unknown[]) => mocks.resolveTtsProvider(...a),
  TtsProviderNotConfiguredError,
}));
vi.mock('@server/utils/deductTtsCredits', () => ({
  deductTtsCredits: (...a: unknown[]) => mocks.deductTtsCredits(...a),
}));
vi.mock('@server/utils/creditPreflight', () => ({
  assertPreflightCredits: (...a: unknown[]) => mocks.assertPreflightCredits(...a),
  InsufficientCreditsPreflightError,
}));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ upload: mocks.upload, getSignedUrl: mocks.getSignedUrl }),
}));

import handler from '../text-to-speech';

const OVERSIZED = 4 * 1024 * 1024 + 1;

const run = () => {
  const { req, res } = createMocks({ method: 'POST', body: { message: 'hello' } });
  (req as Record<string, unknown>).user = { id: 'u1' };
  (req as Record<string, unknown>).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const promise = (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { res, promise };
};

const synthesizes = (audio: Buffer) =>
  mocks.synthesize.mockResolvedValue({ audio, model: 'eleven', characters: 5, contentType: 'audio/mpeg' });

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.resolveTtsProvider.mockResolvedValue({ apiKey: 'k', voice: 'v1' });
  mocks.assertPreflightCredits.mockResolvedValue(undefined);
  mocks.estimateTtsCreditCost.mockReturnValue(42);
  mocks.deductTtsCredits.mockResolvedValue(undefined);
  mocks.upload.mockResolvedValue(undefined);
  mocks.getSignedUrl.mockResolvedValue('https://s3/offload');
  synthesizes(Buffer.from([1, 2, 3]));
});

describe('POST /api/elabs/text-to-speech (legacy)', () => {
  it('returns the base64 audio field, unchanged for existing callers, and bills once', async () => {
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({
      delivery: 'inline',
      audio: Buffer.from([1, 2, 3]).toString('base64'),
      contentType: 'audio/mpeg',
    });
    expect(mocks.deductTtsCredits).toHaveBeenCalledTimes(1);
  });

  it('gates on the elevenlabs default-model estimate for the message length', async () => {
    const { promise } = run();
    await promise;
    expect(mocks.estimateTtsCreditCost).toHaveBeenCalledWith('elevenlabs', 'eleven_multilingual_v2', 5);
    expect(mocks.assertPreflightCredits).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', estimatedCredits: 42 })
    );
  });

  it('returns 402 and never calls the provider when credits are exhausted', async () => {
    mocks.assertPreflightCredits.mockRejectedValue(new InsufficientCreditsPreflightError('broke'));
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(402);
    expect(res._getJSONData()).toEqual({ error: 'broke' });
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });

  it('returns the url variant for oversized audio instead of a 413, and still bills', async () => {
    synthesizes(Buffer.alloc(OVERSIZED));
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ delivery: 'url', url: 'https://s3/offload', bytes: OVERSIZED });
    expect(res._getJSONData().audio).toBeUndefined();
    expect(mocks.deductTtsCredits).toHaveBeenCalledTimes(1);
  });

  it('keeps the generic 500 body when synthesis fails', async () => {
    mocks.synthesize.mockRejectedValue(new Error('boom'));
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(500);
    expect(res._getJSONData()).toEqual({ error: 'Something went wrong' });
  });
});
