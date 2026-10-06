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
      deductTtsCredits: vi.fn(),
      upload: vi.fn(),
      getSignedUrl: vi.fn(),
    },
  };
});

// Passthrough: the real baseApi pulls in auth/db middleware; here the handler is
// driven directly with req.user/req.logger set by the test.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (fn: unknown) => fn }),
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

const run = (body: Record<string, unknown> = { text: 'hello' }) => {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as Record<string, unknown>).user = { id: 'u1' };
  (req as Record<string, unknown>).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const promise = (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { res, promise };
};

const synthesizes = (audio: Buffer) =>
  mocks.synthesize.mockResolvedValue({ audio, model: 'tts-1', characters: 5, contentType: 'audio/mpeg' });

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.resolveTtsProvider.mockResolvedValue({ apiKey: 'k', voice: 'alloy' });
  mocks.assertPreflightCredits.mockResolvedValue(undefined);
  mocks.deductTtsCredits.mockResolvedValue(undefined);
  mocks.upload.mockResolvedValue(undefined);
  mocks.getSignedUrl.mockResolvedValue('https://s3/offload');
  synthesizes(Buffer.from([1, 2, 3]));
});

describe('POST /api/ai/text-to-speech (legacy)', () => {
  it('returns raw audio/mpeg bytes with the legacy cache header and bills once', async () => {
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Content-Type')).toBe('audio/mpeg');
    expect(res.getHeader('Cache-Control')).toBe('public, max-age=3600');
    expect(Buffer.from(res._getData())).toEqual(Buffer.from([1, 2, 3]));
    expect(mocks.deductTtsCredits).toHaveBeenCalledTimes(1);
  });

  it('returns 402 and never calls the provider when credits are exhausted', async () => {
    mocks.assertPreflightCredits.mockRejectedValue(new InsufficientCreditsPreflightError('broke'));
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(402);
    expect(res._getJSONData()).toEqual({ error: 'broke' });
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });

  it('redirects oversized audio with a 303 to a signed URL, uncached, and still bills', async () => {
    synthesizes(Buffer.alloc(OVERSIZED));
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(303);
    expect(res._getRedirectUrl()).toBe('https://s3/offload');
    expect(res.getHeader('Cache-Control')).toBe('no-store');
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.deductTtsCredits).toHaveBeenCalledTimes(1);
  });

  it('returns 413 when the oversized offload fails', async () => {
    synthesizes(Buffer.alloc(OVERSIZED));
    mocks.upload.mockRejectedValue(new Error('s3 down'));
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(413);
    // The legacy 1h cache header must not ride along on a transient failure.
    expect(res.getHeader('Cache-Control')).toBe('no-store');
  });
});
