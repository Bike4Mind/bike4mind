import { describe, it, expect, vi, beforeEach } from 'vitest';

// Drive the raw handler: passthrough dispatchWithLogger (no connectDB / real logger)
// and mock the data + service seams. Mirrors sreJob.test.ts / liveOpsTriage.test.ts.
// Focus: the chunk-failure path must persist a per-file error and account the file as
// failed in its batch (so a bad file is visible instead of silently stuck at
// chunkCount:0), then re-throw so SQS retries then routes to the DLQ.
vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  chunkFabfile: vi.fn(),
  findAccessibleById: vi.fn(),
  markFailedIfNotAlready: vi.fn(),
  updateFileStatus: vi.fn(),
  incrementCounter: vi.fn(),
  getSettingsValue: vi.fn(),
  sendToClient: vi.fn(),
  finalizeBatchIfComplete: vi.fn(),
  isBatchComplete: vi.fn(),
  fabFileUpdateOne: vi.fn(() => ({ catch: vi.fn() })),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: h.getSettingsValue },
  dataLakeBatchRepository: {
    updateFileStatus: h.updateFileStatus,
    incrementCounter: h.incrementCounter,
    claimFileStatus: vi.fn(),
  },
  fabFileChunkRepository: {},
  fabFileRepository: {
    shareable: { findAccessibleById: h.findAccessibleById },
    markFailedIfNotAlready: h.markFailedIfNotAlready,
  },
  FabFile: { updateOne: h.fabFileUpdateOne },
  User: { findById: vi.fn(async () => ({ id: 'u1' })) },
  // Run the callback so chunkFabfile actually executes (and rejects) under test.
  withTransaction: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('@bike4mind/services', () => ({ fabFilesService: { chunkFabfile: h.chunkFabfile } }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: vi.fn(() => ({ getContentAsBuffer: vi.fn() })) }));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: vi.fn() }));
vi.mock('@server/websocket/utils', () => ({ sendToClient: (...a: unknown[]) => h.sendToClient(...a) }));
vi.mock('@server/queueHandlers/dataLakeBatchProgress', () => ({
  finalizeBatchIfComplete: (...a: unknown[]) => h.finalizeBatchIfComplete(...a),
  isBatchComplete: (...a: unknown[]) => h.isBatchComplete(...a),
}));
vi.mock('@bike4mind/common', () => ({ isSupportedEmbeddingModel: vi.fn(() => true) }));
vi.mock('@bike4mind/utils', () => ({ BadRequestError: class BadRequestError extends Error {} }));
vi.mock('sst', () => ({
  Resource: new Proxy({}, { get: () => new Proxy({}, { get: () => 'mock' }) }),
}));

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), updateMetadata: vi.fn() } as never;

import { dispatch } from './fabFileChunk';

const makeEvent = (body: Record<string, unknown>) => ({ Records: [{ body: JSON.stringify(body) }] }) as never;
const payload = { fabFileId: 'ff1', userId: 'u1' };
const CHUNK_ERR = 'Invalid PDF structure';

describe('fabFileChunk handler - chunk-failure surfacing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getSettingsValue.mockResolvedValue('text-embedding-3-small');
    h.findAccessibleById.mockResolvedValue({ id: 'ff1', batchId: 'batch-1' });
    h.markFailedIfNotAlready.mockResolvedValue(true);
    h.incrementCounter.mockResolvedValue({ failedFiles: 1, vectorizedFiles: 0, totalFiles: 3 });
    h.isBatchComplete.mockReturnValue(false);
    h.chunkFabfile.mockRejectedValue(new Error(CHUNK_ERR));
  });

  it('persists a per-file error, marks the file failed in its batch, and re-throws', async () => {
    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow(CHUNK_ERR);
    expect(h.markFailedIfNotAlready).toHaveBeenCalledWith('ff1', CHUNK_ERR);
    expect(h.updateFileStatus).toHaveBeenCalledWith('batch-1', 'ff1', 'failed', CHUNK_ERR);
    expect(h.incrementCounter).toHaveBeenCalledWith('batch-1', 'failedFiles');
    expect(h.sendToClient).toHaveBeenCalledTimes(1);
    // Batch id is attached to log metadata for a data-lake file (incident triage).
    expect(mockLogger.updateMetadata).toHaveBeenCalledWith({ batchId: 'batch-1' });
  });

  it('does not double-count the batch failure on redelivery (markFailedIfNotAlready=false)', async () => {
    h.markFailedIfNotAlready.mockResolvedValue(false);
    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow(CHUNK_ERR);
    expect(h.markFailedIfNotAlready).toHaveBeenCalledWith('ff1', CHUNK_ERR);
    expect(h.incrementCounter).not.toHaveBeenCalled();
    expect(h.updateFileStatus).not.toHaveBeenCalled();
  });

  it('still surfaces the per-file error when the file has no batch', async () => {
    h.findAccessibleById.mockResolvedValue({ id: 'ff1' });
    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow(CHUNK_ERR);
    expect(h.markFailedIfNotAlready).toHaveBeenCalledWith('ff1', CHUNK_ERR);
    expect(h.incrementCounter).not.toHaveBeenCalled();
    // No batch -> no batchId in log metadata.
    expect(mockLogger.updateMetadata).not.toHaveBeenCalledWith({ batchId: 'batch-1' });
  });

  it('marks isChunking true at start and clears it to false even when chunking fails', async () => {
    // The self-host safety-net scan uses isChunking to avoid re-enqueuing a file mid-run;
    // it must be cleared on the failure path so the file can be retried/reprocessed.
    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow(CHUNK_ERR);
    expect(h.fabFileUpdateOne).toHaveBeenCalledWith({ _id: 'ff1' }, { $set: { isChunking: true } });
    expect(h.fabFileUpdateOne).toHaveBeenCalledWith({ _id: 'ff1' }, { $set: { isChunking: false } });
  });
});
