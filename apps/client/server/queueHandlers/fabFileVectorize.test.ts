import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

// Mirror of fabFileChunk.test.ts, scoped to the batchId log-metadata attach. We drive the raw
// handler with a fully-vectorized FabFile so it hits the idempotency early-return right after the
// updateMetadata call - no embedding path is exercised.
vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  findAccessibleById: vi.fn(),
  markFailedIfNotAlready: vi.fn(),
  getVector: vi.fn(),
  getEmbedding: vi.fn(),
  updateFileStatus: vi.fn(),
  incrementCounter: vi.fn(async () => ({ failedFiles: 1, processingFailedFiles: 1 })),
  claimFileStatus: vi.fn(),
  deferFailureIfRetryable: vi.fn(),
  fabFileUpdate: vi.fn(),
  countTerminalChunks: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: vi.fn() },
  apiKeyRepository: {},
  dataLakeBatchRepository: {
    updateFileStatus: h.updateFileStatus,
    incrementCounter: h.incrementCounter,
    claimFileStatus: h.claimFileStatus,
  },
  embeddingCacheRepository: {},
  fabFileChunkRepository: {
    findById: vi.fn(),
    countTerminalChunks: h.countTerminalChunks,
    update: vi.fn(async () => undefined),
  },
  fabFileRepository: {
    shareable: { findAccessibleById: h.findAccessibleById },
    markFailedIfNotAlready: h.markFailedIfNotAlready,
    update: h.fabFileUpdate,
  },
  User: { findById: vi.fn(async () => ({ id: 'u1' })) },
  withTransaction: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('@server/managers/fabFileManager', () => ({ getVector: h.getVector }));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: vi.fn(async () => ({})) },
  embeddingCacheService: { getEmbedding: h.getEmbedding, setEmbedding: vi.fn(async () => undefined) },
}));
vi.mock('@server/queueHandlers/dataLakeBatchProgress', () => ({
  finalizeBatchIfComplete: vi.fn(),
  isBatchComplete: vi.fn(),
  deferFailureIfRetryable: (...a: unknown[]) => h.deferFailureIfRetryable(...a),
}));
vi.mock('@server/websocket/utils', () => ({ sendToClient: vi.fn() }));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));
vi.mock('@server/utils/errors', () => ({ NotFoundError: class NotFoundError extends Error {} }));
// Module-load zod schemas used by VectorizePayload.
vi.mock('@bike4mind/common', () => ({ SupportedEmbeddingModelSchema: z.string() }));
vi.mock('@bike4mind/fab-pipeline', () => ({
  ChunkSchema: z.object({}).passthrough(),
  EmbeddingFactory: class {
    createEmbeddingService() {
      return { getModelInfo: () => ({ contextWindow: 1000 }) };
    }
  },
  getProviderFromModel: vi.fn(() => 'openai'),
  resolveEmbeddingConfig: vi.fn(() => ({ config: {}, missing: null })),
  // Mirror the real name-based guard so any test that reaches the failure branch classifies correctly.
  isEmbeddingAuthError: (e: unknown) => e instanceof Error && e.name === 'EmbeddingAuthError',
}));
vi.mock('sst', () => ({ Resource: new Proxy({}, { get: () => new Proxy({}, { get: () => 'mock' }) }) }));

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), updateMetadata: vi.fn() } as never;

import { fabFileChunkRepository } from '@bike4mind/database';
import { FAB_FILE_VECTORIZE_MAX_RECEIVE_COUNT } from './sqsDelivery';
import { dispatch } from './fabFileVectorize';

const makeEvent = (body: Record<string, unknown>) => ({ Records: [{ body: JSON.stringify(body) }] }) as never;
// Fully-vectorized file -> idempotency early-return right after the batchId metadata attach.
const vectorizedFile = (batchId?: string) => ({
  id: 'ff1',
  batchId,
  vectorized: true,
  chunkCount: 1,
  vectorizedChunkCount: 1,
});
const payload = { userId: 'u1', fabFileId: 'ff1', embeddingModel: 'text-embedding-3-small', chunkIds: ['c1'] };

describe('fabFileVectorize handler - batchId log metadata', () => {
  beforeEach(() => vi.clearAllMocks());

  it('attaches batchId to log metadata for a data-lake file', async () => {
    h.findAccessibleById.mockResolvedValue(vectorizedFile('batch-1'));
    await dispatch(makeEvent(payload), {} as never, mockLogger);
    expect(mockLogger.updateMetadata).toHaveBeenCalledWith({ batchId: 'batch-1' });
  });

  it('omits batchId when the file has no batch', async () => {
    h.findAccessibleById.mockResolvedValue(vectorizedFile(undefined));
    await dispatch(makeEvent(payload), {} as never, mockLogger);
    expect(mockLogger.updateMetadata).not.toHaveBeenCalledWith({ batchId: 'batch-1' });
  });
});

describe('fabFileVectorize handler - stored error copy on vectorization failure', () => {
  // A partially-vectorized file skips the idempotency early-return and drives the embedding path.
  const unvectorizedFile = (batchId?: string) => ({
    id: 'ff1',
    batchId,
    vectorized: false,
    chunkCount: 1,
    vectorizedChunkCount: 0,
  });
  const authError = () => Object.assign(new Error('OPENAI_API_KEY is not set'), { name: 'EmbeddingAuthError' });

  beforeEach(() => {
    vi.clearAllMocks();
    // One valid, embeddable chunk, always a cache miss, so the run reaches the getVector call.
    (fabFileChunkRepository.findById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'c1',
      text: 'hello world',
      tokenCount: 5,
    });
    h.getEmbedding.mockResolvedValue(null);
    h.markFailedIfNotAlready.mockResolvedValue(true);
  });

  it('persists user-safe copy for a turn-attached file on an embedding-auth failure', async () => {
    h.findAccessibleById.mockResolvedValue(unvectorizedFile(undefined));
    h.getVector.mockRejectedValue(authError());

    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow();

    expect(h.markFailedIfNotAlready).toHaveBeenCalledWith(
      'ff1',
      'This file could not be indexed for semantic search because the embedding service was unavailable. You can still ask about it directly in chat.'
    );
  });

  it('persists re-index copy for a data-lake file on an embedding-auth failure', async () => {
    h.findAccessibleById.mockResolvedValue(unvectorizedFile('batch-1'));
    h.getVector.mockRejectedValue(authError());

    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow();

    expect(h.markFailedIfNotAlready).toHaveBeenCalledWith(
      'ff1',
      'This file could not be indexed for semantic search because the embedding service was unavailable. It will not be found by knowledge search until it is re-indexed.'
    );
  });

  it('passes the raw provider message through unchanged for a non-auth failure', async () => {
    h.findAccessibleById.mockResolvedValue(unvectorizedFile(undefined));
    h.getVector.mockRejectedValue(new Error('rate limit exceeded'));

    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow();

    expect(h.markFailedIfNotAlready).toHaveBeenCalledWith('ff1', 'rate limit exceeded');
  });

  it('turn-attached file (no batchId) also only persists its error when not deferred', async () => {
    h.findAccessibleById.mockResolvedValue(unvectorizedFile(undefined));
    h.getVector.mockRejectedValue(new Error('rate limit exceeded'));

    h.deferFailureIfRetryable.mockResolvedValue(true);
    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow();
    expect(h.markFailedIfNotAlready).not.toHaveBeenCalled();

    h.deferFailureIfRetryable.mockResolvedValue(false);
    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow();
    expect(h.markFailedIfNotAlready).toHaveBeenCalledWith('ff1', 'rate limit exceeded');
  });
});

describe('fabFileVectorize handler - retry gating (#1412)', () => {
  // The gate's own attempt-counting/heartbeat behavior is unit-tested directly against
  // deferFailureIfRetryable in dataLakeBatchProgress.test.ts; here we only need to prove the
  // handler wires it correctly: defer -> rethrow with nothing accounted, no-defer -> account
  // exactly like before this fix existed.
  const unvectorizedFile = (batchId?: string) => ({
    id: 'ff1',
    batchId,
    vectorized: false,
    chunkCount: 1,
    vectorizedChunkCount: 0,
  });
  const RATE_LIMIT_ERR = 'rate limit exceeded';

  beforeEach(() => {
    vi.clearAllMocks();
    (fabFileChunkRepository.findById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'c1',
      text: 'hello world',
      tokenCount: 5,
    });
    h.getEmbedding.mockResolvedValue(null);
    h.markFailedIfNotAlready.mockResolvedValue(true);
  });

  it('when deferred (non-final attempt), rethrows with no batch/file accounting', async () => {
    h.findAccessibleById.mockResolvedValue(unvectorizedFile('batch-1'));
    h.getVector.mockRejectedValue(new Error(RATE_LIMIT_ERR));
    h.deferFailureIfRetryable.mockResolvedValue(true);

    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow(RATE_LIMIT_ERR);
    expect(h.deferFailureIfRetryable).toHaveBeenCalledWith(expect.anything(), FAB_FILE_VECTORIZE_MAX_RECEIVE_COUNT, {
      fabFileId: 'ff1',
      batchId: 'batch-1',
      action: 'Vectorization',
      errorMessage: RATE_LIMIT_ERR,
      logger: mockLogger,
    });
    expect(h.markFailedIfNotAlready).not.toHaveBeenCalled();
    expect(h.updateFileStatus).not.toHaveBeenCalled();
    expect(h.incrementCounter).not.toHaveBeenCalled();
  });

  it('the operator-facing auth-failure warning still fires when deferred, even though nothing persists', async () => {
    const authError = Object.assign(new Error('OPENAI_API_KEY is not set'), { name: 'EmbeddingAuthError' });
    h.findAccessibleById.mockResolvedValue(unvectorizedFile('batch-1'));
    h.getVector.mockRejectedValue(authError);
    h.deferFailureIfRetryable.mockResolvedValue(true);

    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('embedding auth'));
    expect(h.markFailedIfNotAlready).not.toHaveBeenCalled();
  });

  it('when not deferred (final attempt), accounts the failure into both counters', async () => {
    h.findAccessibleById.mockResolvedValue(unvectorizedFile('batch-1'));
    h.getVector.mockRejectedValue(new Error(RATE_LIMIT_ERR));
    h.deferFailureIfRetryable.mockResolvedValue(false);

    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow(RATE_LIMIT_ERR);
    expect(h.markFailedIfNotAlready).toHaveBeenCalledWith('ff1', RATE_LIMIT_ERR);
    expect(h.updateFileStatus).toHaveBeenCalledWith('batch-1', 'ff1', 'failed', RATE_LIMIT_ERR);
    expect(h.incrementCounter).toHaveBeenCalledWith('batch-1', 'failedFiles');
    // Separate counter so the client can tell a processing failure from an upload one (#1412).
    expect(h.incrementCounter).toHaveBeenCalledWith('batch-1', 'processingFailedFiles');
  });

  it('a deferred failure followed by a successful retry never touches failedFiles', async () => {
    h.findAccessibleById.mockResolvedValue(unvectorizedFile('batch-1'));
    h.getVector.mockRejectedValue(new Error(RATE_LIMIT_ERR));
    h.deferFailureIfRetryable.mockResolvedValue(true);
    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow(RATE_LIMIT_ERR);
    expect(h.incrementCounter).not.toHaveBeenCalled();

    vi.clearAllMocks();
    (fabFileChunkRepository.findById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'c1',
      text: 'hello world',
      tokenCount: 5,
    });
    h.getEmbedding.mockResolvedValue(null);
    h.findAccessibleById.mockResolvedValue(unvectorizedFile('batch-1'));
    h.getVector.mockResolvedValue([0.1, 0.2]);
    h.countTerminalChunks.mockResolvedValue(1);
    h.claimFileStatus.mockResolvedValue(true);
    h.incrementCounter.mockResolvedValue({ vectorizedFiles: 1, failedFiles: 0, totalFiles: 1 });

    await dispatch(makeEvent(payload), {} as never, mockLogger);
    expect(h.claimFileStatus).toHaveBeenCalledWith('batch-1', 'ff1', ['chunking', 'uploaded', 'pending'], 'complete');
    expect(h.incrementCounter).toHaveBeenCalledWith('batch-1', 'vectorizedFiles');
    expect(h.updateFileStatus).not.toHaveBeenCalledWith('batch-1', 'ff1', 'failed', expect.anything());
  });
});
