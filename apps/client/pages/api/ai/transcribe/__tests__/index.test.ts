import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mocks, InsufficientCreditsPreflightError } = vi.hoisted(() => {
  class InsufficientCreditsPreflightError extends Error {}
  return {
    InsufficientCreditsPreflightError,
    mocks: {
      send: vi.fn(),
      assertPreflightCredits: vi.fn(),
      getOperationsModel: vi.fn(),
      getEffectiveApiKeyByBackend: vi.fn(),
      transcribeOpenAIFromS3: vi.fn(),
      transcribeAWSFromS3: vi.fn(),
      subtractCredits: vi.fn(),
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
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = (...a: unknown[]) => mocks.send(...a);
  },
  HeadObjectCommand: class {
    constructor(public input: unknown) {}
  },
  DeleteObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: (...a: unknown[]) => mocks.getOperationsModel(...a) },
  getEffectiveApiKeyByBackend: (...a: unknown[]) => mocks.getEffectiveApiKeyByBackend(...a),
}));
vi.mock('@server/utils/creditPreflight', () => ({
  assertPreflightCredits: (...a: unknown[]) => mocks.assertPreflightCredits(...a),
  InsufficientCreditsPreflightError,
}));
vi.mock('@bike4mind/services', () => ({
  speechToTextService: {
    ALLOWED_AUDIO_MIME_TYPES: ['audio/mpeg', 'audio/wav'],
    MAX_TRANSCRIBE_BYTES: 25 * 1024 * 1024,
    speechService: class {
      transcribeOpenAIFromS3 = (...a: unknown[]) => mocks.transcribeOpenAIFromS3(...a);
      transcribeAWSFromS3 = (...a: unknown[]) => mocks.transcribeAWSFromS3(...a);
    },
  },
  creditService: { subtractCredits: (...a: unknown[]) => mocks.subtractCredits(...a) },
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: {},
  creditTransactionRepository: {},
  usageEventRepository: { record: () => Promise.resolve() },
}));

import { BadRequestError } from '@server/utils/errors';
import { estimateTranscriptionCost, transcriptionUsdPerMinute } from '@server/utils/transcriptionCost';
import handler from '../index';

const FILE_KEY = 'transcribe-uploads/u1/abc.mp3';
const SIZE = 2 * 1024 * 1024;

const run = (body: Record<string, unknown> = { fileKey: FILE_KEY }) => {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as Record<string, unknown>).user = { id: 'u1' };
  (req as Record<string, unknown>).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const promise = (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { res, promise };
};

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.send.mockImplementation(async (cmd: { constructor: { name: string } }) =>
    cmd.constructor.name === 'HeadObjectCommand' ? { ContentType: 'audio/mpeg', ContentLength: SIZE } : {}
  );
  mocks.getOperationsModel.mockResolvedValue({ speechModelInfo: { backend: 'openai' } });
  mocks.getEffectiveApiKeyByBackend.mockResolvedValue('key');
  mocks.assertPreflightCredits.mockResolvedValue(undefined);
  mocks.transcribeOpenAIFromS3.mockResolvedValue({ text: 'hi' });
  mocks.transcribeAWSFromS3.mockResolvedValue({ text: 'hi' });
  mocks.subtractCredits.mockResolvedValue(undefined);
});

describe('POST /api/ai/transcribe', () => {
  it.each(['openai', 'aws'])(
    'gates on the S3-size estimate at the %s backend rate, then transcribes',
    async backend => {
      mocks.getOperationsModel.mockResolvedValue({ speechModelInfo: { backend } });
      const { res, promise } = run();
      await promise;
      const expected = estimateTranscriptionCost(SIZE, transcriptionUsdPerMinute(backend)).credits;
      expect(expected).toBeGreaterThan(0);
      expect(mocks.assertPreflightCredits).toHaveBeenCalledWith({
        userId: 'u1',
        estimatedCredits: expected,
        featureLabel: 'transcription',
      });
      expect(res._getJSONData()).toEqual({ text: 'hi' });
      expect(mocks.subtractCredits).toHaveBeenCalledTimes(1);
    }
  );

  it('rejects with a 400-class error and never calls the provider or bills when credits are short', async () => {
    mocks.assertPreflightCredits.mockRejectedValue(new InsufficientCreditsPreflightError('broke'));
    const { promise } = run();
    await expect(promise).rejects.toBeInstanceOf(BadRequestError);
    expect(mocks.transcribeOpenAIFromS3).not.toHaveBeenCalled();
    expect(mocks.transcribeAWSFromS3).not.toHaveBeenCalled();
    expect(mocks.subtractCredits).not.toHaveBeenCalled();
  });

  it('still deletes the transient S3 upload when the credit gate refuses', async () => {
    mocks.assertPreflightCredits.mockRejectedValue(new InsufficientCreditsPreflightError('broke'));
    const { promise } = run();
    await expect(promise).rejects.toBeInstanceOf(BadRequestError);
    const deletes = mocks.send.mock.calls.filter(([cmd]) => cmd.constructor.name === 'DeleteObjectCommand');
    expect(deletes).toHaveLength(1);
    expect(deletes[0][0].input).toMatchObject({ Key: FILE_KEY });
  });
});
