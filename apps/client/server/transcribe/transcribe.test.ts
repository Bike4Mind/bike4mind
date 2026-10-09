/**
 * The `mapProviderError` hook of transcribeUpload, which only the public route passes. Everything
 * else in the helper is pinned through the SPA routes in pages/api/ai/transcribe/__tests__.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSend, mockGetOperationsModel, mockOpenAI } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockGetOperationsModel: vi.fn(),
  mockOpenAI: vi.fn(),
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
  getEffectiveApiKeyByBackend: async () => 'sk-test',
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: async () => ({ id: 'u1', currentCredits: 10 }) },
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

const { transcribeUpload, TranscribeRequestError } = await import('./transcribe');

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
