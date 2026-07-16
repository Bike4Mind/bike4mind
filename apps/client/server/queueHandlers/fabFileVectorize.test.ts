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
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: vi.fn() },
  apiKeyRepository: {},
  embeddingCacheRepository: {},
  fabFileChunkRepository: { findById: vi.fn() },
  fabFileRepository: { shareable: { findAccessibleById: h.findAccessibleById } },
  User: { findById: vi.fn(async () => ({ id: 'u1' })) },
  withTransaction: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('@server/managers/fabFileManager', () => ({ getVector: vi.fn() }));
vi.mock('@bike4mind/services', () => ({ apiKeyService: {}, embeddingCacheService: {} }));
vi.mock('@server/queueHandlers/dataLakeBatchProgress', () => ({
  finalizeBatchIfComplete: vi.fn(),
  isBatchComplete: vi.fn(),
}));
vi.mock('@server/websocket/utils', () => ({ sendToClient: vi.fn() }));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));
vi.mock('@server/utils/errors', () => ({ NotFoundError: class NotFoundError extends Error {} }));
// Module-load zod schemas used by VectorizePayload.
vi.mock('@bike4mind/common', () => ({ SupportedEmbeddingModelSchema: z.string() }));
vi.mock('@bike4mind/fab-pipeline', () => ({
  ChunkSchema: z.object({}).passthrough(),
  EmbeddingFactory: class {},
  getProviderFromModel: vi.fn(),
}));
vi.mock('sst', () => ({ Resource: new Proxy({}, { get: () => new Proxy({}, { get: () => 'mock' }) }) }));

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), updateMetadata: vi.fn() } as never;

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
