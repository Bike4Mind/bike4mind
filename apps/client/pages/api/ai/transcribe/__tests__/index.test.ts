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
      recordUsage: vi.fn(),
      settlementDraw: vi.fn(),
    },
  };
});

// The real stochastic rounding, with its draw pinned so the debit is assertable.
vi.mock('@bike4mind/common', async importActual => {
  const actual = await importActual<typeof import('@bike4mind/common')>();
  return {
    ...actual,
    usdToCreditsStochastic: (usd: number) => actual.usdToCreditsStochastic(usd, () => mocks.settlementDraw()),
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
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: (...a: unknown[]) => mocks.getOperationsModel(...a) },
  getEffectiveApiKeyByBackend: (...a: unknown[]) => mocks.getEffectiveApiKeyByBackend(...a),
}));
// Stands in for the real reservation: settle writes the ledger row through subtractCredits and, like
// the real one, logs rather than throws when that write fails, and writes no row for a 0 charge
// (settleCreditHold in creditHold.ts, chargeDirectly in creditPreflight.ts).
const { fakeHold } = vi.hoisted(() => ({
  fakeHold: (
    subtract: (...a: unknown[]) => unknown,
    args: { userId: string; logger: { error: (...a: unknown[]) => void } }
  ) => ({
    settle: async (credits: number, entry: Record<string, unknown>) => {
      if (credits === 0) return 0;
      try {
        await subtract({ ...entry, ownerId: args.userId, credits }, {});
      } catch (err) {
        args.logger.error('settlement failed', { err });
      }
      return credits;
    },
    release: async () => undefined,
  }),
}));

vi.mock('@server/utils/creditPreflight', () => ({
  assertPreflightCredits: (...a: unknown[]) => mocks.assertPreflightCredits(...a),
  holdPreflightCredits: async ({
    req,
    requiredCredits,
    featureLabel,
    billingOrganizationId,
  }: {
    req: { user: { id: string }; logger: Parameters<typeof fakeHold>[1]['logger'] };
    requiredCredits: number;
    featureLabel: string;
    billingOrganizationId?: string | null;
  }) => {
    const args = {
      userId: req.user.id,
      estimatedCredits: requiredCredits,
      featureLabel,
      billingOrganizationId,
    };
    await mocks.assertPreflightCredits(args);
    return fakeHold(mocks.subtractCredits, { ...args, logger: req.logger });
  },
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
  usageEventRepository: { record: (...a: unknown[]) => mocks.recordUsage(...a) },
}));

import { CREDITS_PER_USD_COST } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { estimateTranscriptionCost, transcriptionUsdPerMinute } from '@server/utils/transcriptionCost';
import handler from '../index';

const FILE_KEY = 'transcribe-uploads/u1/abc.mp3';
const SIZE = 2 * 1024 * 1024;

const run = (body: Record<string, unknown> = { fileKey: FILE_KEY }, receivedAt = new Date()) => {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as Record<string, unknown>).user = { id: 'u1' };
  (req as Record<string, unknown>).receivedAt = receivedAt;
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
  mocks.recordUsage.mockResolvedValue(undefined);
  mocks.settlementDraw.mockReturnValue(0.5);
});

describe('POST /api/ai/transcribe', () => {
  it('rejects an expired request with 504 before taking credits or calling the provider', async () => {
    const { promise } = run({ fileKey: FILE_KEY }, new Date(Date.now() - 60_000));
    await expect(promise).rejects.toMatchObject({ statusCode: 504, additionalInfo: { errorCode: 'request_timeout' } });
    expect(mocks.assertPreflightCredits).not.toHaveBeenCalled();
    expect(mocks.transcribeOpenAIFromS3).not.toHaveBeenCalled();
  });

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
        billingOrganizationId: null,
      });
      expect(res._getJSONData()).toEqual({ text: 'hi' });
      // The debit prices the same backend-rate USD the gate admitted on, settled stochastically
      // (draw 0.5 vs this size's fraction), never above the gate's round-up.
      const { costUsd } = estimateTranscriptionCost(SIZE, transcriptionUsdPerMinute(backend));
      const charged = mocks.subtractCredits.mock.calls[0][0].credits;
      expect([Math.floor(costUsd * CREDITS_PER_USD_COST), Math.ceil(costUsd * CREDITS_PER_USD_COST)]).toContain(
        charged
      );
      expect(charged).toBeLessThanOrEqual(expected);
      expect(mocks.subtractCredits).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'speech_to_text_usage', model: backend }),
        expect.anything()
      );
    }
  );

  describe('final debit rounding', () => {
    const rate = transcriptionUsdPerMinute('openai');
    // Bytes that cost exactly N + 0.5 credits at the openai rate.
    const bytesForCredits = (credits: number) =>
      Math.round(credits / (estimateTranscriptionCost(1, rate).costUsd * CREDITS_PER_USD_COST));
    const head = (length: number) =>
      mocks.send.mockImplementation(async (cmd: { constructor: { name: string } }) =>
        cmd.constructor.name === 'HeadObjectCommand' ? { ContentType: 'audio/mpeg', ContentLength: length } : {}
      );

    it.each([
      [0.25, 4],
      [0.75, 3],
    ])('debits N or N+1 for a cost of N + 0.5 credits (draw %s -> %s)', async (draw, expected) => {
      head(bytesForCredits(3.5));
      mocks.settlementDraw.mockReturnValue(draw);
      const { promise } = run();
      await promise;
      expect(mocks.subtractCredits).toHaveBeenCalledWith(
        expect.objectContaining({ credits: expected }),
        expect.anything()
      );
      expect(mocks.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ creditsCharged: expected }));
    });

    it('keeps the pre-flight gate on the round-up of the same call', async () => {
      head(bytesForCredits(3.5));
      mocks.settlementDraw.mockReturnValue(0.75);
      const { promise } = run();
      await promise;
      expect(mocks.assertPreflightCredits).toHaveBeenCalledWith(expect.objectContaining({ estimatedCredits: 4 }));
    });

    it('debits 0 for a tiny cost: no ledger row, but the usage event still records it', async () => {
      head(bytesForCredits(0.05));
      mocks.settlementDraw.mockReturnValue(0.5);
      const { promise } = run();
      await promise;
      expect(mocks.subtractCredits).not.toHaveBeenCalled();
      expect(mocks.recordUsage).toHaveBeenCalledWith(
        expect.objectContaining({ feature: 'transcription', creditsCharged: 0 })
      );
      // The gate still demanded a whole credit.
      expect(mocks.assertPreflightCredits).toHaveBeenCalledWith(expect.objectContaining({ estimatedCredits: 1 }));
    });
  });

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
