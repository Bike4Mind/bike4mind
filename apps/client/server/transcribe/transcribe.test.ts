/**
 * The rejection `kind` each gate throws (the v1 routes map it onto a status in
 * toPublicTranscribeError) and the `mapProviderError` hook, which only the public route passes. The
 * legacy 400 answers are pinned through the SPA routes in pages/api/ai/transcribe/__tests__.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockSend,
  mockGetOperationsModel,
  mockOpenAI,
  mockAWS,
  mockGetApiKey,
  mockAssertCredits,
  mockHoldCredits,
  mockPresign,
  hold,
} = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockGetOperationsModel: vi.fn(),
  mockOpenAI: vi.fn(),
  mockAWS: vi.fn(),
  mockGetApiKey: vi.fn(),
  mockAssertCredits: vi.fn(),
  mockHoldCredits: vi.fn(),
  mockPresign: vi.fn(),
  hold: { settle: vi.fn(), release: vi.fn() },
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = mockSend;
  },
  HeadObjectCommand: class {
    kind = 'head';
  },
  DeleteObjectCommand: class {
    kind = 'delete';
  },
}));
vi.mock('@aws-sdk/s3-presigned-post', () => ({
  createPresignedPost: (...a: unknown[]) => mockPresign(...a),
}));
vi.mock('sst', () => ({ Resource: { appFilesBucket: { name: 'test-bucket' } } }));
vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: mockGetOperationsModel },
  getEffectiveApiKeyByBackend: mockGetApiKey,
}));
vi.mock('@server/utils/transcriptionCost', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  assertTranscriptionCredits: mockAssertCredits,
  holdTranscriptionCredits: mockHoldCredits,
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: {},
  organizationRepository: {},
  adminSettingsRepository: {},
  creditTransactionRepository: {},
  usageEventRepository: { record: vi.fn() },
}));
vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<typeof import('@bike4mind/services')>();
  return {
    ...actual,
    speechToTextService: {
      ...actual.speechToTextService,
      speechService: class {
        transcribeOpenAIFromS3 = mockOpenAI;
        transcribeAWSFromS3 = mockAWS;
      },
    },
    creditService: { subtractCredits: vi.fn() },
  };
});

const { createTranscribeUpload, transcribeUpload, TranscribeRequestError } = await import('./transcribe');
const { BadRequestError } = await import('@server/utils/errors');
const { speechToTextService } = await import('@bike4mind/services');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const mapped = new Error('mapped');
const run = () =>
  transcribeUpload({
    userId: 'u1',
    fileKey: 'transcribe-uploads/u1/a.mp3',
    receivedAt: new Date(),
    logger,
    mapProviderError: () => mapped,
  });
const deletes = () => mockSend.mock.calls.filter(([cmd]) => cmd.kind === 'delete');

beforeEach(() => {
  vi.clearAllMocks();
  mockOpenAI.mockReset().mockResolvedValue({ text: 'hello' });
  mockAWS.mockReset().mockResolvedValue({ text: 'hello' });
  mockHoldCredits.mockReset();
  hold.settle.mockReset();
  mockSend.mockImplementation(async (cmd: { kind: string }) =>
    cmd.kind === 'head' ? { ContentType: 'audio/mpeg', ContentLength: 1000 } : {}
  );
  mockGetOperationsModel.mockResolvedValue({ speechModelInfo: { backend: 'openai' } });
  mockGetApiKey.mockResolvedValue('sk-test');
  mockAssertCredits.mockResolvedValue(undefined);
  mockHoldCredits.mockResolvedValue(hold);
  hold.settle.mockResolvedValue(0);
  hold.release.mockResolvedValue(undefined);
  mockPresign.mockResolvedValue({ url: 'https://s3.example/upload', fields: {} });
});

const head = (ContentType: string, ContentLength: number) =>
  mockSend.mockImplementation(async (cmd: { kind: string }) =>
    cmd.kind === 'head' ? { ContentType, ContentLength } : {}
  );

describe('transcribeUpload rejection kinds', () => {
  it.each([
    [
      'a HEAD miss',
      'not_found',
      () =>
        mockSend.mockImplementation(async (cmd: { kind: string }) => {
          if (cmd.kind === 'head') throw new Error('NotFound');
          return {};
        }),
    ],
    ['a video upload', 'unsupported_type', () => head('video/mp4', 1000)],
    ['an empty upload', 'size_out_of_range', () => head('audio/mpeg', 0)],
    [
      'an oversized upload',
      'size_out_of_range',
      () => head('audio/mpeg', speechToTextService.MAX_TRANSCRIBE_BYTES + 1),
    ],
    ['no speech model', 'not_configured', () => mockGetOperationsModel.mockResolvedValue({})],
    ['no provider key', 'not_configured', () => mockGetApiKey.mockResolvedValue(undefined)],
    [
      'a balance that cannot pay',
      'insufficient_credits',
      () => mockHoldCredits.mockRejectedValue(new BadRequestError('Insufficient credits')),
    ],
  ])('tags %s as %s', async (_label, kind, arrange) => {
    arrange();
    await expect(run()).rejects.toMatchObject({ kind });
    expect(mockOpenAI).not.toHaveBeenCalled();
  });

  it('tags a key outside the caller prefix as invalid_key', async () => {
    await expect(
      transcribeUpload({ userId: 'u1', fileKey: 'transcribe-uploads/u2/a.mp3', receivedAt: new Date(), logger })
    ).rejects.toMatchObject({ kind: 'invalid_key' });
  });

  it('rethrows a credit pre-flight fault that is not a BadRequestError unchanged', async () => {
    const fault = new Error('db down');
    mockHoldCredits.mockRejectedValue(fault);

    await expect(run()).rejects.toBe(fault);
  });
});

describe('transcribeUpload credit hold', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects an already expired request before reading metadata or taking a hold', async () => {
    const result = transcribeUpload({
      userId: 'u1',
      fileKey: 'transcribe-uploads/u1/a.mp3',
      receivedAt: new Date(Date.now() - 60_000),
      logger,
    });
    await expect(result).rejects.toMatchObject({ statusCode: 504 });
    expect(mockHoldCredits).not.toHaveBeenCalled();
    expect(mockSend.mock.calls.filter(([command]) => command.kind === 'head')).toHaveLength(0);
  });

  it.each(['openai', 'aws'])('aborts %s and refunds before the server deadline, without settling', async backend => {
    vi.useFakeTimers();
    mockGetOperationsModel.mockResolvedValue({ speechModelInfo: { backend } });
    let providerStarted = false;
    const waitForAbort = (...args: unknown[]) => {
      providerStarted = true;
      const { abortSignal } = args.at(-1) as { abortSignal: AbortSignal };
      return new Promise((_, reject) => {
        abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
      });
    };
    mockOpenAI.mockImplementation(waitForAbort);
    mockAWS.mockImplementation(waitForAbort);

    const result = run().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(providerStarted).toBe(true);
    await vi.advanceTimersByTimeAsync(45_000);

    expect(await result).toMatchObject({ statusCode: 504 });
    expect(hold.release).toHaveBeenCalledTimes(1);
    expect(hold.settle).not.toHaveBeenCalled();
    expect(deletes()).toHaveLength(1);
  });

  it('counts auth and setup time against the deadline before taking a hold', async () => {
    vi.useFakeTimers();
    const receivedAt = new Date(Date.now() - 40_000);
    mockGetOperationsModel.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 6_000));
      return { speechModelInfo: { backend: 'aws' } };
    });
    const result = transcribeUpload({ userId: 'u1', fileKey: 'transcribe-uploads/u1/a.mp3', receivedAt, logger }).catch(
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await result).toMatchObject({ statusCode: 504 });
    expect(mockHoldCredits).not.toHaveBeenCalled();
    expect(mockAWS).not.toHaveBeenCalled();
  });

  it('refunds a hold that finishes after the deadline without starting the provider', async () => {
    vi.useFakeTimers();
    mockHoldCredits.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 46_000));
      return hold;
    });
    const result = run().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(46_000);
    expect(await result).toMatchObject({ statusCode: 504 });
    expect(hold.release).toHaveBeenCalledTimes(1);
    expect(mockOpenAI).not.toHaveBeenCalled();
  });

  it('settles a completed result even when settlement crosses the provider deadline', async () => {
    vi.useFakeTimers();
    mockOpenAI.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 44_000));
      return { text: 'finished' };
    });
    hold.settle.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 2_000));
      return 0;
    });
    const result = run();
    await vi.advanceTimersByTimeAsync(46_000);
    expect(await result).toEqual({ text: 'finished' });
    expect(hold.settle).toHaveBeenCalledTimes(1);
    expect(hold.release).not.toHaveBeenCalled();
  });

  it('holds the size-based cost before the provider runs, then settles that hold', async () => {
    mockOpenAI.mockImplementation(async () => {
      expect(mockHoldCredits).toHaveBeenCalledTimes(1);
      return { text: 'hello' };
    });

    await run();

    const [, heldCredits] = mockHoldCredits.mock.calls[0];
    expect(heldCredits).toBeGreaterThan(0);
    expect(hold.settle).toHaveBeenCalledWith(heldCredits, expect.objectContaining({ type: 'speech_to_text_usage' }));
    expect(hold.release).not.toHaveBeenCalled();
  });

  it('releases the hold when the provider fails, and never settles it', async () => {
    mockOpenAI.mockRejectedValue(new Error('provider exploded'));

    await expect(run()).rejects.toBe(mapped);
    expect(hold.release).toHaveBeenCalledTimes(1);
    expect(hold.settle).not.toHaveBeenCalled();
  });
});

describe('createTranscribeUpload', () => {
  it('tags a balance that cannot pay as insufficient_credits before minting', async () => {
    mockAssertCredits.mockRejectedValue(new BadRequestError('Insufficient credits'));

    await expect(
      createTranscribeUpload({ userId: 'u1', mimeType: 'audio/mpeg', fileSize: 1000 })
    ).rejects.toMatchObject({ kind: 'insufficient_credits' });
    expect(mockPresign).not.toHaveBeenCalled();
  });
});

describe('transcribeUpload mapProviderError', () => {
  it('rewraps a provider failure and still deletes the upload', async () => {
    mockOpenAI.mockRejectedValue(new Error('provider exploded'));

    await expect(run()).rejects.toBe(mapped);
    expect(deletes()).toHaveLength(1);
  });

  it('leaves a request rejection from the dispatch alone', async () => {
    mockGetOperationsModel.mockResolvedValue({ speechModelInfo: { backend: 'carrier-pigeon' } });

    await expect(run()).rejects.toBeInstanceOf(TranscribeRequestError);
    expect(deletes()).toHaveLength(1);
  });
});
