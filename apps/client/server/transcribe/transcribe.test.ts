/**
 * The rejection `kind` each gate throws (the v1 routes map it onto a status in
 * toPublicTranscribeError) and the `mapProviderError` hook, which only the public route passes. The
 * legacy 400 answers are pinned through the SPA routes in pages/api/ai/transcribe/__tests__.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSend, mockGetOperationsModel, mockOpenAI, mockGetApiKey, mockAssertCredits } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockGetOperationsModel: vi.fn(),
  mockOpenAI: vi.fn(),
  mockGetApiKey: vi.fn(),
  mockAssertCredits: vi.fn(),
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
vi.mock('sst', () => ({ Resource: { appFilesBucket: { name: 'test-bucket' } } }));
vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: mockGetOperationsModel },
  getEffectiveApiKeyByBackend: mockGetApiKey,
}));
vi.mock('@server/utils/transcriptionCost', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  assertTranscriptionCredits: mockAssertCredits,
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: {},
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
      },
    },
    creditService: { subtractCredits: vi.fn() },
  };
});

const { createTranscribeUpload, transcribeUpload, TranscribeRequestError } = await import('./transcribe');
const { BadRequestError } = await import('@server/utils/errors');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const mapped = new Error('mapped');
const run = () =>
  transcribeUpload({ userId: 'u1', fileKey: 'transcribe-uploads/u1/a.mp3', logger, mapProviderError: () => mapped });
const deletes = () => mockSend.mock.calls.filter(([cmd]) => cmd.kind === 'delete');

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockImplementation(async (cmd: { kind: string }) =>
    cmd.kind === 'head' ? { ContentType: 'audio/mpeg', ContentLength: 1000 } : {}
  );
  mockGetOperationsModel.mockResolvedValue({ speechModelInfo: { backend: 'openai' } });
  mockGetApiKey.mockResolvedValue('sk-test');
  mockAssertCredits.mockResolvedValue(undefined);
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
    ['no speech model', 'not_configured', () => mockGetOperationsModel.mockResolvedValue({})],
    ['no provider key', 'not_configured', () => mockGetApiKey.mockResolvedValue(undefined)],
    [
      'a balance that cannot pay',
      'insufficient_credits',
      () => mockAssertCredits.mockRejectedValue(new BadRequestError('Insufficient credits')),
    ],
  ])('tags %s as %s', async (_label, kind, arrange) => {
    arrange();
    await expect(run()).rejects.toMatchObject({ kind });
    expect(mockOpenAI).not.toHaveBeenCalled();
  });

  it('tags a key outside the caller prefix as invalid_key', async () => {
    await expect(
      transcribeUpload({ userId: 'u1', fileKey: 'transcribe-uploads/u2/a.mp3', logger })
    ).rejects.toMatchObject({ kind: 'invalid_key' });
  });

  it('rethrows a credit pre-flight fault that is not a BadRequestError unchanged', async () => {
    const fault = new Error('db down');
    mockAssertCredits.mockRejectedValue(fault);

    await expect(run()).rejects.toBe(fault);
  });
});

describe('createTranscribeUpload', () => {
  it('tags a balance that cannot pay as insufficient_credits before minting', async () => {
    mockAssertCredits.mockRejectedValue(new BadRequestError('Insufficient credits'));

    await expect(
      createTranscribeUpload({ userId: 'u1', mimeType: 'audio/mpeg', fileSize: 1000 })
    ).rejects.toMatchObject({ kind: 'insufficient_credits' });
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
