import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mocks, InsufficientCreditsPreflightError } = vi.hoisted(() => {
  class InsufficientCreditsPreflightError extends Error {}
  return {
    InsufficientCreditsPreflightError,
    mocks: {
      assertPreflightCredits: vi.fn(),
      createPresignedPost: vi.fn(),
    },
  };
});

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (fn: unknown) => fn }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: unknown) => fn,
}));
vi.mock('sst', () => ({ Resource: { appFilesBucket: { name: 'bucket' } } }));
vi.mock('@aws-sdk/client-s3', () => ({ S3Client: class {} }));
vi.mock('@aws-sdk/s3-presigned-post', () => ({
  createPresignedPost: (...a: unknown[]) => mocks.createPresignedPost(...a),
}));
vi.mock('@server/utils/creditPreflight', () => ({
  assertPreflightCredits: (...a: unknown[]) => mocks.assertPreflightCredits(...a),
  InsufficientCreditsPreflightError,
}));
vi.mock('@bike4mind/services', () => ({
  speechToTextService: {
    ALLOWED_AUDIO_MIME_TYPES: ['audio/mpeg', 'audio/wav'],
    MAX_TRANSCRIBE_BYTES: 25 * 1024 * 1024,
  },
}));

import { BadRequestError } from '@server/utils/errors';
import { estimateTranscriptionCost, MIN_TRANSCRIPTION_USD_PER_MINUTE } from '@server/utils/transcriptionCost';
import handler from '../init';

const SIZE = 2 * 1024 * 1024;

const run = () => {
  const { req, res } = createMocks({ method: 'POST', body: { mimeType: 'audio/mpeg', fileSize: SIZE } });
  (req as Record<string, unknown>).user = { id: 'u1' };
  (req as Record<string, unknown>).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const promise = (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { res, promise };
};

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.assertPreflightCredits.mockResolvedValue(undefined);
  mocks.createPresignedPost.mockResolvedValue({ url: 'https://s3/post', fields: { k: 'v' } });
});

describe('POST /api/ai/transcribe/init', () => {
  it('gates on the declared-size estimate at the cheapest backend rate, then issues the presigned POST', async () => {
    const { res, promise } = run();
    await promise;
    const expected = estimateTranscriptionCost(SIZE, MIN_TRANSCRIPTION_USD_PER_MINUTE).credits;
    expect(expected).toBeGreaterThan(0);
    expect(mocks.assertPreflightCredits).toHaveBeenCalledWith({
      userId: 'u1',
      estimatedCredits: expected,
      featureLabel: 'transcription',
    });
    expect(res._getJSONData()).toMatchObject({ url: 'https://s3/post', fields: { k: 'v' } });
  });

  it('rejects with a 400-class error and issues no presigned POST when credits are short', async () => {
    mocks.assertPreflightCredits.mockRejectedValue(new InsufficientCreditsPreflightError('broke'));
    const { promise } = run();
    await expect(promise).rejects.toBeInstanceOf(BadRequestError);
    expect(mocks.createPresignedPost).not.toHaveBeenCalled();
  });
});
