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
  incrementCounters: vi.fn(),
  claimFileStatus: vi.fn(),
  getSettingsValue: vi.fn(),
  sendToClient: vi.fn(async () => undefined),
  finalizeBatchIfComplete: vi.fn(),
  isBatchComplete: vi.fn(),
  deferFailureIfRetryable: vi.fn(),
  fabFileUpdateOne: vi.fn(() => ({ catch: vi.fn() })),
  selfHostOpenSearchEnabled: vi.fn(() => false),
  recomputeFileChunkPolicyConflict: vi.fn(async () => null),
  resolveScopedSetting: vi.fn(async () => ({ value: 512, source: 'platform' })),
  sendToQueue: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: h.getSettingsValue },
  dataLakeBatchRepository: {
    updateFileStatus: h.updateFileStatus,
    incrementCounter: h.incrementCounter,
    incrementCounters: h.incrementCounters,
    claimFileStatus: h.claimFileStatus,
  },
  fabFileChunkRepository: {},
  fabFileRepository: {
    shareable: { findAccessibleById: h.findAccessibleById },
    markFailedIfNotAlready: h.markFailedIfNotAlready,
  },
  // Deps for the convergence kill switch (#1676), built eagerly on every message. Never exercised
  // by these user-origin payloads (origin absent -> user work short-circuits before any read), but
  // the named exports must exist so the deps object can be constructed.
  dataLakeRepository: { findById: vi.fn() },
  scopedSettingsRepository: { findOverrides: vi.fn() },
  FabFile: { updateOne: h.fabFileUpdateOne },
  User: { findById: vi.fn(async () => ({ id: 'u1' })) },
  // Run the callback so chunkFabfile actually executes (and rejects) under test.
  withTransaction: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('@bike4mind/services', () => ({
  fabFilesService: { chunkFabfile: h.chunkFabfile },
  // Owner-altitude chunk-policy resolution (#1662). The resolver never throws; default it to the
  // platform value so the handler proceeds exactly as before these seams existed. scopeForLake
  // (#1676) is only reached for background lake work; stubbed so the deps object can be constructed.
  scopedSettingsService: {
    scopeForFileOwner: vi.fn(() => ({ owner: { id: 'u1', type: 'user' } })),
    resolveScopedSetting: h.resolveScopedSetting,
    scopeForLake: vi.fn(),
  },
  dataLakeService: {
    resolveSpendLevers: vi.fn(async () => ({ vectorizeChunkBatchSize: 50 })),
    recomputeFileChunkPolicyConflict: h.recomputeFileChunkPolicyConflict,
  },
}));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: vi.fn(() => ({ getContentAsBuffer: vi.fn() })) }));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: (...a: unknown[]) => h.sendToQueue(...a) }));
vi.mock('@server/websocket/utils', () => ({ sendToClient: (...a: unknown[]) => h.sendToClient(...a) }));
vi.mock('@server/queueHandlers/dataLakeBatchProgress', () => ({
  finalizeBatchIfComplete: (...a: unknown[]) => h.finalizeBatchIfComplete(...a),
  isBatchComplete: (...a: unknown[]) => h.isBatchComplete(...a),
  deferFailureIfRetryable: (...a: unknown[]) => h.deferFailureIfRetryable(...a),
}));
vi.mock('@bike4mind/common', () => ({
  isSupportedEmbeddingModel: vi.fn(() => true),
  DATA_LAKE_VECTORIZE_CHUNK_BATCH_SIZE_DEFAULT: 50,
}));
vi.mock('@bike4mind/utils', () => ({ BadRequestError: class BadRequestError extends Error {} }));
vi.mock('@bike4mind/fab-pipeline', () => ({
  FabFileChunkSearchIndex: { deleteByFabFileId: vi.fn() },
  effectiveChunkTokenLimit: vi.fn(() => 512),
}));
vi.mock('@bike4mind/db-core', () => ({ selfHostOpenSearchEnabled: h.selfHostOpenSearchEnabled }));
vi.mock('sst', () => ({
  Resource: new Proxy({}, { get: () => new Proxy({}, { get: () => 'mock' }) }),
}));

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), updateMetadata: vi.fn() } as never;

import { FAB_FILE_CHUNK_MAX_RECEIVE_COUNT } from './sqsDelivery';
import { NO_EXTRACTABLE_TEXT_NOTE_PREFIX } from '@server/worker/chunkScan';
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
    h.incrementCounters.mockResolvedValue({
      failedFiles: 1,
      processingFailedFiles: 1,
      vectorizedFiles: 0,
      totalFiles: 3,
    });
    h.isBatchComplete.mockReturnValue(false);
    h.chunkFabfile.mockRejectedValue(new Error(CHUNK_ERR));
  });

  it('persists a per-file error, marks the file failed in its batch, and re-throws', async () => {
    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow(CHUNK_ERR);
    expect(h.markFailedIfNotAlready).toHaveBeenCalledWith('ff1', CHUNK_ERR);
    expect(h.updateFileStatus).toHaveBeenCalledWith('batch-1', 'ff1', 'failed', CHUNK_ERR);
    // One atomic call for both counters, so a crash between two sequential $inc writes can
    // never misclassify a processing failure as an upload one (#1412).
    expect(h.incrementCounters).toHaveBeenCalledWith('batch-1', { failedFiles: 1, processingFailedFiles: 1 });
    expect(h.sendToClient).toHaveBeenCalledWith(
      'u1',
      expect.anything(),
      expect.objectContaining({ failedFiles: 1, processingFailedFiles: 1 })
    );
    // Batch id is attached to log metadata for a data-lake file (incident triage).
    expect(mockLogger.updateMetadata).toHaveBeenCalledWith({ batchId: 'batch-1' });
  });

  it('does not double-count the batch failure on redelivery (markFailedIfNotAlready=false)', async () => {
    h.markFailedIfNotAlready.mockResolvedValue(false);
    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow(CHUNK_ERR);
    expect(h.markFailedIfNotAlready).toHaveBeenCalledWith('ff1', CHUNK_ERR);
    expect(h.incrementCounters).not.toHaveBeenCalled();
    expect(h.updateFileStatus).not.toHaveBeenCalled();
  });

  it('still surfaces the per-file error when the file has no batch', async () => {
    h.findAccessibleById.mockResolvedValue({ id: 'ff1' });
    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow(CHUNK_ERR);
    expect(h.markFailedIfNotAlready).toHaveBeenCalledWith('ff1', CHUNK_ERR);
    expect(h.incrementCounters).not.toHaveBeenCalled();
    // No batch -> no batchId in log metadata.
    expect(mockLogger.updateMetadata).not.toHaveBeenCalledWith({ batchId: 'batch-1' });
  });

  it('marks isChunking true at start and clears it to false even when chunking fails', async () => {
    // The self-host safety-net scan uses isChunking to avoid re-enqueuing a file mid-run;
    // it must be cleared on the failure path so the file can be retried/reprocessed.
    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow(CHUNK_ERR);
    // The claim also stamps chunkClaimedAt (Date) so the rescue sweep can reclaim a hard-killed run.
    expect(h.fabFileUpdateOne).toHaveBeenCalledWith(
      { _id: 'ff1' },
      { $set: { isChunking: true, chunkClaimedAt: expect.any(Date) } }
    );
    expect(h.fabFileUpdateOne).toHaveBeenCalledWith({ _id: 'ff1' }, { $set: { isChunking: false } });
  });
});

describe('fabFileChunk handler - retry gating (#1412)', () => {
  // The gate's own attempt-counting/heartbeat behavior is unit-tested directly against
  // deferFailureIfRetryable in dataLakeBatchProgress.test.ts; here we only need to prove the
  // handler wires it correctly: defer -> rethrow with nothing accounted, no-defer -> account
  // exactly like before this fix existed.
  beforeEach(() => {
    vi.clearAllMocks();
    h.getSettingsValue.mockResolvedValue('text-embedding-3-small');
    h.findAccessibleById.mockResolvedValue({ id: 'ff1', batchId: 'batch-1' });
    h.markFailedIfNotAlready.mockResolvedValue(true);
    h.incrementCounters.mockResolvedValue({
      failedFiles: 1,
      processingFailedFiles: 1,
      vectorizedFiles: 0,
      totalFiles: 3,
    });
    h.isBatchComplete.mockReturnValue(false);
    h.chunkFabfile.mockRejectedValue(new Error(CHUNK_ERR));
  });

  it('when deferred (non-final attempt), rethrows with no batch/file accounting', async () => {
    h.deferFailureIfRetryable.mockResolvedValue(true);
    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow(CHUNK_ERR);
    expect(h.deferFailureIfRetryable).toHaveBeenCalledWith(expect.anything(), FAB_FILE_CHUNK_MAX_RECEIVE_COUNT, {
      fabFileId: 'ff1',
      batchId: 'batch-1',
      action: 'Chunking',
      errorMessage: CHUNK_ERR,
      logger: mockLogger,
    });
    expect(h.markFailedIfNotAlready).not.toHaveBeenCalled();
    expect(h.updateFileStatus).not.toHaveBeenCalled();
    expect(h.incrementCounters).not.toHaveBeenCalled();
    expect(h.finalizeBatchIfComplete).not.toHaveBeenCalled();
    expect(h.sendToClient).not.toHaveBeenCalled();
  });

  it('still clears isChunking when deferred', async () => {
    h.deferFailureIfRetryable.mockResolvedValue(true);
    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow(CHUNK_ERR);
    expect(h.fabFileUpdateOne).toHaveBeenCalledWith({ _id: 'ff1' }, { $set: { isChunking: false } });
  });

  it('when not deferred (final attempt), accounts the failure into both counters atomically', async () => {
    h.deferFailureIfRetryable.mockResolvedValue(false);
    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow(CHUNK_ERR);
    expect(h.markFailedIfNotAlready).toHaveBeenCalledWith('ff1', CHUNK_ERR);
    expect(h.updateFileStatus).toHaveBeenCalledWith('batch-1', 'ff1', 'failed', CHUNK_ERR);
    expect(h.incrementCounters).toHaveBeenCalledWith('batch-1', { failedFiles: 1, processingFailedFiles: 1 });
  });

  it('a deferred failure followed by a successful retry never touches failedFiles', async () => {
    h.deferFailureIfRetryable.mockResolvedValue(true);
    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow(CHUNK_ERR);
    expect(h.incrementCounters).not.toHaveBeenCalled();

    vi.clearAllMocks();
    h.getSettingsValue.mockResolvedValue('text-embedding-3-small');
    h.findAccessibleById.mockResolvedValue({ id: 'ff1', batchId: 'batch-1' });
    h.chunkFabfile.mockResolvedValue([{ id: 'c1' }]);
    h.claimFileStatus.mockResolvedValue(true);
    h.incrementCounter.mockResolvedValue({ chunkedFiles: 1, failedFiles: 0, totalFiles: 1 });

    await dispatch(makeEvent(payload), {} as never, mockLogger);
    expect(h.claimFileStatus).toHaveBeenCalledWith('batch-1', 'ff1', ['uploaded', 'pending'], 'chunking');
    expect(h.incrementCounter).toHaveBeenCalledWith('batch-1', 'chunkedFiles');
    expect(h.incrementCounters).not.toHaveBeenCalled();
  });
});

describe('fabFileChunk handler - idempotency guard against re-chunking (human review)', () => {
  // chunkFabfile unconditionally deletes then recreates every chunk. Without this guard, a
  // duplicate delivery (a rescue-sweep re-enqueue racing a deferred, non-final failure's own
  // later natural redelivery - see chunkScan.ts) would wipe out and replace chunks a prior
  // successful delivery already created, including any already vectorized.
  beforeEach(() => vi.clearAllMocks());

  it('skips re-chunking a file already marked chunked, without ever calling chunkFabfile', async () => {
    h.findAccessibleById.mockResolvedValue({ id: 'ff1', batchId: 'batch-1', chunked: true });
    await dispatch(makeEvent(payload), {} as never, mockLogger);
    expect(h.chunkFabfile).not.toHaveBeenCalled();
    // objectContaining so the guard still fires if the claim's $set gains fields (e.g. chunkClaimedAt).
    expect(h.fabFileUpdateOne).not.toHaveBeenCalledWith(
      { _id: 'ff1' },
      expect.objectContaining({ $set: expect.objectContaining({ isChunking: true }) })
    );
  });

  it('skips re-chunking a file already flagged as producing no extractable text', async () => {
    h.findAccessibleById.mockResolvedValue({
      id: 'ff1',
      batchId: 'batch-1',
      chunked: false,
      notes: `${NO_EXTRACTABLE_TEXT_NOTE_PREFIX} - re-process or re-upload.`,
    });
    await dispatch(makeEvent(payload), {} as never, mockLogger);
    expect(h.chunkFabfile).not.toHaveBeenCalled();
  });

  it('still chunks a file that has not been chunked yet', async () => {
    h.findAccessibleById.mockResolvedValue({ id: 'ff1', batchId: 'batch-1', chunked: false });
    h.getSettingsValue.mockResolvedValue('text-embedding-3-small');
    h.chunkFabfile.mockResolvedValue([]);
    await dispatch(makeEvent(payload), {} as never, mockLogger);
    expect(h.chunkFabfile).toHaveBeenCalled();
  });
});

describe('fabFileChunk handler - notification failures are non-fatal (human review)', () => {
  // A throw from the chunk-complete push (e.g. a dropped websocket) must not stop the
  // batch claim/increment that follows it in the same handler run - that push is
  // best-effort UI feedback, not part of the accounting this fix depends on.
  beforeEach(() => {
    vi.clearAllMocks();
    h.getSettingsValue.mockResolvedValue('text-embedding-3-small');
    h.findAccessibleById.mockResolvedValue({ id: 'ff1', batchId: 'batch-1' });
    h.chunkFabfile.mockResolvedValue([{ id: 'c1' }]);
    h.claimFileStatus.mockResolvedValue(true);
    h.incrementCounter.mockResolvedValue({ chunkedFiles: 1, failedFiles: 0, totalFiles: 1 });
  });

  it('a rejecting sendToClient does not prevent the batch claim/increment from completing', async () => {
    h.sendToClient.mockRejectedValue(new Error('socket gone'));
    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).resolves.toBeUndefined();
    expect(h.claimFileStatus).toHaveBeenCalledWith('batch-1', 'ff1', ['uploaded', 'pending'], 'chunking');
    expect(h.incrementCounter).toHaveBeenCalledWith('batch-1', 'chunkedFiles');
  });
});

describe('fabFileChunk handler - passage target: payload override vs owner-altitude (#1420, #1662)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getSettingsValue.mockResolvedValue('text-embedding-3-small');
    h.findAccessibleById.mockResolvedValue({ id: 'ff1', userId: 'u1' });
    h.chunkFabfile.mockResolvedValue([]);
    h.resolveScopedSetting.mockResolvedValue({ value: 512, source: 'platform' });
  });

  it('forwards an explicit payload chunkSize as passageTokenTarget, overriding owner-altitude policy', async () => {
    // chunkSize was historically transported and silently dropped (#1420); an explicit value from
    // the UI reprocess door must still reach the service and win over the resolved policy (#1662).
    h.resolveScopedSetting.mockResolvedValue({ value: 512, source: 'owner' });
    await dispatch(makeEvent({ ...payload, chunkSize: '750' }), {} as never, mockLogger);
    expect(h.chunkFabfile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ passageTokenTarget: 750 }),
      expect.anything()
    );
  });

  it('resolves the owner-altitude chunk policy when the payload has no chunkSize (#1662)', async () => {
    // No explicit payload value: the automatic doors now inherit the owner-altitude policy (which
    // falls through to the platform DefaultChunkSize) instead of a hard-coded chunker default.
    h.resolveScopedSetting.mockResolvedValue({ value: 999, source: 'owner' });
    await dispatch(makeEvent(payload), {} as never, mockLogger);
    expect(h.chunkFabfile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ passageTokenTarget: 999 }),
      expect.anything()
    );
  });
});

describe('fabFileChunk handler - cross-lake chunk-policy conflict (#1662)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getSettingsValue.mockResolvedValue('text-embedding-3-small');
    h.findAccessibleById.mockResolvedValue({ id: 'ff1', userId: 'u1', tags: [{ name: 'datalake:sales' }] });
    h.resolveScopedSetting.mockResolvedValue({ value: 512, source: 'platform' });
  });

  it('recomputes the conflict with the effective target once the file is chunked', async () => {
    h.chunkFabfile.mockResolvedValue([{ id: 'c1' }]); // non-empty -> past the zero-chunk early return
    await dispatch(makeEvent(payload), {} as never, mockLogger);
    expect(h.recomputeFileChunkPolicyConflict).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ff1', userId: 'u1' }),
      512, // effectiveChunkTokenLimit is mocked to 512
      expect.objectContaining({ embeddingModel: 'text-embedding-3-small' })
    );
  });

  it('does not run the conflict check for a zero-chunk file (nothing to satisfy)', async () => {
    h.chunkFabfile.mockResolvedValue([]); // zero chunks -> early return before the conflict check
    await dispatch(makeEvent(payload), {} as never, mockLogger);
    expect(h.recomputeFileChunkPolicyConflict).not.toHaveBeenCalled();
  });

  it('a conflict-check failure does not fail the chunk run', async () => {
    h.chunkFabfile.mockResolvedValue([{ id: 'c1' }]);
    h.recomputeFileChunkPolicyConflict.mockRejectedValue(new Error('lake read failed'));
    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).resolves.toBeUndefined();
  });
});

describe('fabFileChunk handler - self-host OpenSearch searchIndex adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getSettingsValue.mockResolvedValue('text-embedding-3-small');
    h.findAccessibleById.mockResolvedValue({ id: 'ff1' });
    h.chunkFabfile.mockResolvedValue([]);
  });

  it('passes the searchIndex adapter when self-host OpenSearch is enabled', async () => {
    h.selfHostOpenSearchEnabled.mockReturnValue(true);
    await dispatch(makeEvent(payload), {} as never, mockLogger);
    expect(h.chunkFabfile).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ searchIndex: expect.objectContaining({ deleteByFabFileId: expect.any(Function) }) })
    );
  });

  it('omits the searchIndex adapter when self-host OpenSearch is disabled', async () => {
    h.selfHostOpenSearchEnabled.mockReturnValue(false);
    await dispatch(makeEvent(payload), {} as never, mockLogger);
    expect(h.chunkFabfile).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ searchIndex: undefined })
    );
  });
});

describe('fabFileChunk handler - convergence kill switch (#1676)', () => {
  const convergencePayload = { ...payload, origin: 'convergence' as const };
  const switchOn = async (key: string) => (key === 'PauseLakeConvergence' ? true : 'text-embedding-3-small');
  const switchOff = async (key: string) => (key === 'PauseLakeConvergence' ? false : 'text-embedding-3-small');

  beforeEach(() => {
    vi.clearAllMocks();
    h.getSettingsValue.mockImplementation(switchOff);
    h.findAccessibleById.mockResolvedValue({ id: 'ff1', chunked: false });
    h.chunkFabfile.mockResolvedValue([{ id: 'c1' }]);
    h.claimFileStatus.mockResolvedValue(false);
  });

  it('halts a convergence message when the switch is on, before any file work', async () => {
    h.getSettingsValue.mockImplementation(switchOn);

    await dispatch(makeEvent(convergencePayload), {} as never, mockLogger);

    // Gated before the fabFile load, the chunk, and the isChunking claim; nothing fans out.
    expect(h.findAccessibleById).not.toHaveBeenCalled();
    expect(h.chunkFabfile).not.toHaveBeenCalled();
    expect(h.fabFileUpdateOne).not.toHaveBeenCalledWith({ _id: 'ff1' }, { $set: { isChunking: true } });
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('never halts user work (origin absent) even when the switch is on', async () => {
    h.getSettingsValue.mockImplementation(switchOn);

    await dispatch(makeEvent(payload), {} as never, mockLogger); // no origin -> user

    expect(h.chunkFabfile).toHaveBeenCalled();
  });

  it('forwards origin + lakeId into the vectorize fan-out so the switch still bites downstream', async () => {
    await dispatch(makeEvent({ ...convergencePayload, lakeId: 'lake-9' }), {} as never, mockLogger);

    expect(h.sendToQueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fabFileId: 'ff1', origin: 'convergence', lakeId: 'lake-9' })
    );
  });
});
