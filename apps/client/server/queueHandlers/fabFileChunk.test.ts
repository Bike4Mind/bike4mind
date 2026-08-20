import { describe, it, expect, vi, beforeEach } from 'vitest';

// Drive the raw handler: passthrough dispatchWithLogger (no connectDB / real logger)
// and mock the data + service seams. Mirrors sreJob.test.ts / liveOpsTriage.test.ts.
// Focus: the chunk-failure path must persist a per-file error and account the file as
// failed in its batch (so a bad file is visible instead of silently stuck at
// chunkCount:0), then re-throw so SQS retries then routes to the DLQ.
vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
  // Declared, not spread from the real module: this mock exists to keep `utils`' import-time
  // Config/DB wiring out of the test. Any NEW export the handler starts importing has to be added
  // here too, or it arrives as undefined and the handler misbehaves silently.
  MARK_PAUSED_MAX_ATTEMPTS: 3,
  MARK_PAUSED_RETRY_DELAY_MS: 0, // 0 so the backoff does not add real delay to the suite
}));

type PreparedStub = { args: unknown[] };

const h = vi.hoisted(() => {
  const chunkFabfile = vi.fn();
  // Live transaction nesting depth, so a test can observe WHICH phase runs inside withTransaction
  // (#1681 constraint 3). Tracked by the passthrough itself rather than a per-test
  // mockImplementation, so every other test keeps the exact same behaviour it had before.
  const transactionDepth = { current: 0 };
  return {
    chunkFabfile,
    transactionDepth,
    withTransaction: vi.fn(async (fn: () => unknown) => {
      transactionDepth.current += 1;
      try {
        return await fn();
      } finally {
        transactionDepth.current -= 1;
      }
    }),
    // Prepare is a pure carrier here; commit replays the captured call into `chunkFabfile`, which
    // remains the one seam the assertions below inspect. Deliberately NOT two independent mocks:
    // the split is an execution-context change, not a behavior change, and the tests should keep
    // asserting the single "what did we ask the chunker to do" question.
    prepareFabFileChunks: vi.fn(async (...args: unknown[]) => ({ args })),
    commitFabFileChunks: vi.fn(async (prepared: unknown) =>
      chunkFabfile(...((prepared as PreparedStub | undefined)?.args ?? []))
      ),
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
    // The lease acquire: truthy doc = claim won (acquired). Default wins; a test overrides it to null
    // to exercise a superseded/duplicate delivery bailing out.
    fabFileFindOneAndUpdate: vi.fn(async () => ({ _id: 'ff1' })),
    selfHostOpenSearchEnabled: vi.fn(() => false),
    recomputeFileChunkPolicyConflict: vi.fn(async () => null),
    resolveScopedSetting: vi.fn(async () => ({ value: 512, source: 'platform' })),
    sendToQueue: vi.fn(),
    fabFileUpdate: vi.fn(async () => null),
  };
});

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
    update: h.fabFileUpdate,
  },
  // Deps for the convergence kill switch (#1676), built eagerly on every message. Never exercised
  // by these user-origin payloads (origin absent -> user work short-circuits before any read), but
  // the named exports must exist so the deps object can be constructed.
  dataLakeRepository: { findById: vi.fn() },
  scopedSettingsRepository: { findOverrides: vi.fn() },
  FabFile: { updateOne: h.fabFileUpdateOne, findOneAndUpdate: h.fabFileFindOneAndUpdate },
  User: { findById: vi.fn(async () => ({ id: 'u1' })) },
  // Run the callback so the commit phase actually executes (and rejects) under test.
  withTransaction: h.withTransaction,
}));

// Whole-module mock, NOT importActual: importActual('@bike4mind/services') loads the package barrel
// (services/dist/index.mjs), whose top-level creditService import throws in this environment - it
// can't even collect. The two admission helpers below are pure and dependency-free; their real
// implementations are covered in admissionContract.test.ts, so this mirror only needs to stay
// behaviorally faithful (deriveAdmissionStatus: conflict->quarantined; admissionDoorLabel: ?? unknown).
vi.mock('@bike4mind/services', () => ({
  // The handler runs chunking in two phases (#1681 constraint 3): prepare (S3 + tokenize) outside
  // the transaction, commit (the writes) inside it. `h.chunkFabfile` stays the SINGLE behavioral
  // seam these tests drive - prepare just carries its arguments forward and commit replays them -
  // so every existing `toHaveBeenCalledWith(user, params, adapters)` assertion still describes what
  // the handler asked for, and a rejection still surfaces from inside `withTransaction`.
  fabFilesService: {
    prepareFabFileChunks: h.prepareFabFileChunks,
    commitFabFileChunks: h.commitFabFileChunks,
  },
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
    deriveAdmissionStatus: (conflict: unknown) => (conflict ? 'quarantined' : 'admitted'),
    admissionDoorLabel: (sourceType: string | undefined) => sourceType ?? 'unknown',
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
vi.mock('@bike4mind/common', () => {
  class ChunkClaimLostError extends Error {
    constructor(public fabFileId: string) {
      super(`Chunk claim for FabFile ${fabFileId} was lost to a successor mid-run`);
      this.name = 'ChunkClaimLostError';
    }
  }
  return {
    isSupportedEmbeddingModel: vi.fn(() => true),
    DATA_LAKE_VECTORIZE_CHUNK_BATCH_SIZE_DEFAULT: 50,
    // Real value, not a placeholder: the halt path writes it and the assertion below is what keeps
    // the handler's marker and the evaluators' predicate reading the same string.
    CONVERGENCE_PAUSED_CHUNK_NOTE:
      'Re-chunking paused by the data-lake convergence kill switch - its passages were removed and are ' +
      'rebuilt when convergence resumes.',
    ChunkClaimLostError,
    // Mirrors the REAL dual-check in errors.ts exactly (not just re-declaring the class) - an
    // `instanceof`-only mock here would make F2's regression test below tautological, the same gap
    // the real bug would hide behind.
    isChunkClaimLostError: (err: unknown): boolean =>
      Boolean(err && (err instanceof ChunkClaimLostError || (err as Error).name === 'ChunkClaimLostError')),
  };
});
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
import { ChunkClaimLostError } from '@bike4mind/common';

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

  it('acquires the lease (isChunking true + chunkClaimedAt) and clears it even when chunking fails', async () => {
    // The self-host safety-net scan uses isChunking to avoid re-enqueuing a file mid-run;
    // it must be cleared on the failure path so the file can be retried/reprocessed.
    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow(CHUNK_ERR);
    // Acquire is a compare-and-set findOneAndUpdate that stamps chunkClaimedAt (the claim token) so
    // the rescue sweep can reclaim a hard-killed run and a duplicate delivery can be rejected.
    expect(h.fabFileFindOneAndUpdate).toHaveBeenCalledWith(expect.objectContaining({ _id: 'ff1' }), {
      $set: { isChunking: true, chunkClaimedAt: expect.any(Date) },
    });
    expect(h.fabFileUpdateOne).toHaveBeenCalledWith(
      { _id: 'ff1', chunkClaimedAt: expect.any(Date) },
      { $set: { isChunking: false } }
    );
    // IDENTITY, not shape. expect.any(Date) above passes for a fresh `new Date()` in the release,
    // which would silently match nothing in production and cascade one takeover into a third worker
    // (the round-8 P2 (4)). toBe, not toEqual: two Dates in the same millisecond compare equal, and
    // that is exactly the clock-flakiness removed elsewhere in this branch.
    const [, claimUpdate] = h.fabFileFindOneAndUpdate.mock.calls[0];
    const [releaseQuery] = h.fabFileUpdateOne.mock.calls[0];
    expect(releaseQuery.chunkClaimedAt).toBe(claimUpdate.$set.chunkClaimedAt);
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
    expect(h.fabFileUpdateOne).toHaveBeenCalledWith(
      { _id: 'ff1', chunkClaimedAt: expect.any(Date) },
      { $set: { isChunking: false } }
    );
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
    h.getSettingsValue.mockResolvedValue('text-embedding-3-small');
    h.fabFileFindOneAndUpdate.mockResolvedValue({ _id: 'ff1' });
    h.findAccessibleById.mockResolvedValue({ id: 'ff1', batchId: 'batch-1', chunked: true });
    await dispatch(makeEvent(payload), {} as never, mockLogger);
    expect(h.chunkFabfile).not.toHaveBeenCalled();
    // The lease is briefly held then released by the finally, but the destructive re-chunk is skipped.
    expect(h.fabFileUpdateOne).toHaveBeenCalledWith(
      { _id: 'ff1', chunkClaimedAt: expect.any(Date) },
      { $set: { isChunking: false } }
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

  it('logs a report-only quarantine diagnostic naming the door when the member cannot honor a policy (#1679)', async () => {
    // The member came through the Drive connector; recompute reports a conflict against one lake.
    h.findAccessibleById.mockResolvedValue({
      id: 'ff1',
      userId: 'u1',
      tags: [{ name: 'datalake:sales' }],
      sourceType: 'google_drive',
    });
    h.chunkFabfile.mockResolvedValue([{ id: 'c1' }]);
    h.recomputeFileChunkPolicyConflict.mockResolvedValue({
      effectiveTarget: 512,
      embeddingModel: 'text-embedding-3-small',
      lakes: [{ lakeId: 'l1', name: 'Sales' }],
      detectedAt: new Date(),
    });

    await dispatch(makeEvent(payload), {} as never, mockLogger);

    const warned = (mockLogger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(c => String(c[0]));
    const admissionLine = warned.find(line => line.includes('[admission]'));
    expect(admissionLine).toBeDefined();
    expect(admissionLine).toContain('quarantined');
    expect(admissionLine).toContain('google_drive');
  });

  it('does not log an admission quarantine when the member honors every applicable policy (#1679)', async () => {
    h.chunkFabfile.mockResolvedValue([{ id: 'c1' }]);
    h.recomputeFileChunkPolicyConflict.mockResolvedValue(null); // no conflict -> admitted

    await dispatch(makeEvent(payload), {} as never, mockLogger);

    const warned = (mockLogger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(c => String(c[0]));
    expect(warned.some(line => line.includes('[admission]'))).toBe(false);
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
    // Non-halt cases run the claim-lease acquire first; give it a winning CAS so they proceed.
    h.fabFileFindOneAndUpdate.mockResolvedValue({ _id: 'ff1' });
  });

  it('halts a convergence message when the switch is on, before any file work', async () => {
    h.getSettingsValue.mockImplementation(switchOn);

    await dispatch(makeEvent(convergencePayload), {} as never, mockLogger);

    // Gated before the fabFile load, the chunk, and the isChunking claim; nothing fans out.
    expect(h.findAccessibleById).not.toHaveBeenCalled();
    expect(h.chunkFabfile).not.toHaveBeenCalled();
    expect(h.fabFileFindOneAndUpdate).not.toHaveBeenCalled();
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

describe('fabFileChunk handler - single-run claim (human review)', () => {
  // chunkFabfile's deleteManyByFabFileId is destructive, so at most one worker may run it per file.
  // This compare-and-set is the ONLY mutual exclusion in the chunk path - producers just reset and
  // enqueue - so these assert the query shape. The behaviour they cannot see (that a real document
  // actually satisfies the query a producer leaves behind) is covered against a real DB in
  // packages/database/src/__tests__/fabFileRebuildPassages.test.ts; three review rounds shipped a
  // broken handoff green precisely because findOneAndUpdate is mocked here.
  beforeEach(() => {
    vi.clearAllMocks();
    h.getSettingsValue.mockResolvedValue('text-embedding-3-small');
    h.findAccessibleById.mockResolvedValue({ id: 'ff1', chunked: false });
    h.chunkFabfile.mockResolvedValue([]);
  });

  it('claims a free-or-stale file and stamps chunkClaimedAt', async () => {
    h.fabFileFindOneAndUpdate.mockResolvedValue({ _id: 'ff1' });
    await dispatch(makeEvent(payload), {} as never, mockLogger);
    const [query, update] = h.fabFileFindOneAndUpdate.mock.calls[0] as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
    ];
    expect(query._id).toBe('ff1');
    // Three arms: free, stale claim, null-stamp backfill - mirroring buildFabFileChunkScanFilter so
    // the sweep and the worker agree on what "in flight" means.
    expect((query.$or as unknown[]).length).toBe(3);
    expect(update.$set).toMatchObject({ isChunking: true });
    expect(update.$set.chunkClaimedAt).toBeInstanceOf(Date);
    expect(h.chunkFabfile).toHaveBeenCalled();
  });

  it('every delivery presents the same claim - there is no producer token to carry', async () => {
    h.fabFileFindOneAndUpdate.mockResolvedValue({ _id: 'ff1' });
    const evt = makeEvent(payload);

    await dispatch(evt, {} as never, mockLogger); // attempt 1
    await dispatch(evt, {} as never, mockLogger); // attempt 2: SQS redelivery of the SAME message

    const calls = h.fabFileFindOneAndUpdate.mock.calls as [Record<string, unknown>][];
    expect(calls).toHaveLength(2);
    // Assert the SHAPE, not deep equality: the stale arm embeds `new Date()` per dispatch, so two
    // attempts are only byte-identical when they land in the same millisecond. Deep-equality here
    // passed locally and on two CI runs before failing on a slower one - a clock-dependent test,
    // which is the thing it was supposed to be proving does NOT matter.
    for (const [query] of calls) {
      expect(query._id).toBe('ff1');
      expect(query.$or).toHaveLength(3); // free / stale / null-stamp - same arms every delivery
      // Closes the class, not just the one name: toHaveLength counts arms inside the $or and says
      // nothing about extra conjuncts beside it, so a token reintroduced as leaseId or
      // chunkClaimToken would pass a not.toHaveProperty('chunkLeaseId') check.
      expect(Object.keys(query).sort()).toEqual(['$or', '_id']);
    }
    // The retry genuinely re-runs: exclusion is the live isChunking state, not a token the first
    // attempt consumed, so nothing about attempt 1 can silently disqualify attempt 2.
    expect(h.chunkFabfile).toHaveBeenCalledTimes(2);
  });

  it('a duplicate delivery (lost CAS) skips chunking AND does not clear the winner isChunking', async () => {
    h.fabFileFindOneAndUpdate.mockResolvedValue(null); // another worker holds the claim
    await dispatch(makeEvent(payload), {} as never, mockLogger);
    expect(h.chunkFabfile).not.toHaveBeenCalled();
    // Critically: the finally must NOT run for a delivery that never won the claim, or it would
    // release the ACTUAL owner's claim mid-run.
    expect(h.fabFileUpdateOne).not.toHaveBeenCalled();
  });

  it("threads this run's claimed chunkClaimedAt stamp into chunkFabfile", async () => {
    h.fabFileFindOneAndUpdate.mockResolvedValue({ _id: 'ff1' });
    await dispatch(makeEvent(payload), {} as never, mockLogger);
    const [, claimUpdate] = h.fabFileFindOneAndUpdate.mock.calls[0];
    expect(h.chunkFabfile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ chunkClaimedAt: claimUpdate.$set.chunkClaimedAt }),
      expect.anything()
    );
  });
});

describe('fabFileChunk handler - stale-claim takeover mid-run (#1802 Phase 2)', () => {
  // chunkFabfile's guarded-write ownership check throws ChunkClaimLostError when a successor has
  // already taken over this file's claim. This must be treated as a benign no-op - not a failure,
  // not a retry, not DLQ-bound - since the successor is the one actually finishing the file.
  beforeEach(() => {
    vi.clearAllMocks();
    h.getSettingsValue.mockResolvedValue('text-embedding-3-small');
    h.findAccessibleById.mockResolvedValue({ id: 'ff1', batchId: 'batch-1' });
    h.fabFileFindOneAndUpdate.mockResolvedValue({ _id: 'ff1' });
    h.chunkFabfile.mockRejectedValue(new ChunkClaimLostError('ff1'));
  });

  it('resolves successfully instead of rejecting', async () => {
    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).resolves.toBeUndefined();
  });

  it('does not defer/retry, mark the file failed, or touch batch failure accounting', async () => {
    await dispatch(makeEvent(payload), {} as never, mockLogger);
    expect(h.deferFailureIfRetryable).not.toHaveBeenCalled();
    expect(h.markFailedIfNotAlready).not.toHaveBeenCalled();
    expect(h.updateFileStatus).not.toHaveBeenCalled();
    expect(h.incrementCounters).not.toHaveBeenCalled();
  });

  it('does not dispatch vectorize work or batch-progress notifications for this stale run', async () => {
    await dispatch(makeEvent(payload), {} as never, mockLogger);
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(h.claimFileStatus).not.toHaveBeenCalled();
  });

  it("still releases this run's own claim stamp in the finally (a safe no-op since the successor already re-stamped it)", async () => {
    await dispatch(makeEvent(payload), {} as never, mockLogger);
    expect(h.fabFileUpdateOne).toHaveBeenCalledWith(
      { _id: 'ff1', chunkClaimedAt: expect.any(Date) },
      { $set: { isChunking: false } }
    );
  });

  it("logs at WARN, not INFO - a swallow path per queueHandlers/utils.ts's own documented contract", async () => {
    await dispatch(makeEvent(payload), {} as never, mockLogger);
    // Pins the actual wording this PR changed, not just "chunk claim lost" - that substring is
    // also present in the OLD (pre-fix) message, so asserting only it would still pass against a
    // full revert of the reword (round-2 PR review finding, verified: reverting to the old string
    // keeps this test green unless the "or the file was removed" clause is also asserted).
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('or the file was removed'));
    expect(mockLogger.log).not.toHaveBeenCalledWith(expect.stringContaining('chunk claim lost'));
  });

  // Regression guard for the cross-package instanceof gap: a rejection that is NOT an instance of
  // this test file's own mocked ChunkClaimLostError class - only carrying the same `.name` - must
  // still be treated as the benign no-op, exactly as it would be if @bike4mind/common were ever
  // resolved as two distinct module realms in production. An instanceof-only check fails this.
  it('still treats a same-named-but-different-realm error as the benign no-op', async () => {
    h.chunkFabfile.mockRejectedValue(Object.assign(new Error('cross-realm'), { name: 'ChunkClaimLostError' }));
    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).resolves.toBeUndefined();
    expect(h.markFailedIfNotAlready).not.toHaveBeenCalled();
    expect(h.deferFailureIfRetryable).not.toHaveBeenCalled();
  });
});

// #1681 constraint 3: the S3 fetch and the tokenization must NOT run inside the Mongo transaction.
// Under the old shape a member too large to finish inside the transaction lifetime aborted with a
// code `withTransaction` classifies as transient, so the download and tokenization were redone up
// to `maxRetries` more times before failing deterministically - and convergence sweeps the largest
// documents FIRST. The invariant is about execution CONTEXT, which no assertion on the chunker's
// arguments can see, so this observes the transaction boundary directly.
describe('fabFileChunk handler - chunk computation runs outside the transaction (#1681)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getSettingsValue.mockResolvedValue('text-embedding-3-small');
    h.findAccessibleById.mockResolvedValue({ id: 'ff1', chunked: false });
    h.chunkFabfile.mockResolvedValue([{ id: 'c1' }]);
  });

  it('prepares (fetch + tokenize) outside the transaction and commits (writes) inside it', async () => {
    const contexts: { phase: string; insideTransaction: boolean }[] = [];
    h.prepareFabFileChunks.mockImplementation(async (...args: unknown[]) => {
      contexts.push({ phase: 'prepare', insideTransaction: h.transactionDepth.current > 0 });
      return { args };
    });
    h.commitFabFileChunks.mockImplementation(async () => {
      contexts.push({ phase: 'commit', insideTransaction: h.transactionDepth.current > 0 });
      return [{ id: 'c1' }];
    });

    await dispatch(makeEvent(payload), {} as never, mockLogger);

    expect(contexts).toEqual([
      { phase: 'prepare', insideTransaction: false },
      { phase: 'commit', insideTransaction: true },
    ]);
  });

  // A prepare-phase throw is no longer wrapped by withTransaction, so it reaches a DIFFERENT catch
  // site than it used to. It must still land on the same failure accounting - otherwise a corrupt
  // PDF would stop being marked failed and would sit at chunkCount:0 with no error, the exact
  // silently-stuck state that accounting exists to prevent.
  it('routes a prepare-phase failure through the same failure accounting', async () => {
    h.deferFailureIfRetryable.mockResolvedValue(false);
    h.prepareFabFileChunks.mockRejectedValue(new Error('corrupt pdf'));

    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow('corrupt pdf');
    expect(h.markFailedIfNotAlready).toHaveBeenCalledWith('ff1', 'corrupt pdf');
  });

  // Same reasoning for the benign arm: a claim lost during prepare must stay a no-op.
  it('still treats a prepare-phase lost claim as the benign no-op', async () => {
    h.prepareFabFileChunks.mockRejectedValue(new ChunkClaimLostError('ff1'));

    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).resolves.toBeUndefined();
    expect(h.markFailedIfNotAlready).not.toHaveBeenCalled();
    expect(h.deferFailureIfRetryable).not.toHaveBeenCalled();
  });
});

// The kill switch's producer-side check refuses a run while the switch is already ON, so this is
// the case that reaches here: the switch was flipped WHILE a wave was in flight, which is the
// switch's whole purpose. By now the producer has already deleted these files' passages.
describe('fabFileChunk handler - convergence kill switch', () => {
  const PAUSED_CHUNK_NOTE =
    'Re-chunking paused by the data-lake convergence kill switch - its passages were removed and are ' +
    'rebuilt when convergence resumes.';
  const convergencePayload = { fabFileId: 'ff1', userId: 'u1', origin: 'convergence', lakeId: undefined };

  beforeEach(() => {
    vi.clearAllMocks();
    h.getSettingsValue.mockImplementation(async (key: string) =>
      key === 'PauseLakeConvergence' ? true : 'text-embedding-3-small'
    );
    h.findAccessibleById.mockResolvedValue({ id: 'ff1', batchId: 'batch-1' });
  });

  it('drops the message without chunking when the switch is on', async () => {
    await expect(dispatch(makeEvent(convergencePayload), {} as never, mockLogger)).resolves.toBeUndefined();

    expect(h.prepareFabFileChunks).not.toHaveBeenCalled();
    expect(h.fabFileFindOneAndUpdate).not.toHaveBeenCalled();
  });

  // Without this the file sits at chunkCount:0 with no error - a shape indistinguishable from an
  // image or a pending upload, which is how QA's stranded document fell out of health's denominator,
  // out of the convergence plan and past the retrieval withhold all at once.
  it('marks the file so every reader can tell "passages deleted" from "never had any"', async () => {
    await dispatch(makeEvent(convergencePayload), {} as never, mockLogger);

    expect(h.fabFileUpdate).toHaveBeenCalledWith({ id: 'ff1', notes: PAUSED_CHUNK_NOTE });
  });

  // A transient failure must not cost the marker, so the write is retried in-process before the
  // delivery is failed. This pins that the retry is what handles the realistic case.
  it('retries the marker write and acks once it succeeds', async () => {
    h.fabFileUpdate.mockRejectedValueOnce(new Error('pool timeout')).mockResolvedValueOnce(undefined);

    await expect(dispatch(makeEvent(convergencePayload), {} as never, mockLogger)).resolves.toBeUndefined();
    expect(h.fabFileUpdate).toHaveBeenCalledTimes(2);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  // This assertion used to be `resolves.toBeUndefined()`, on the reasoning that failing the delivery
  // would "only retry it against a switch that is still on". That does not hold: fabFileChunkQueue
  // sets `dlq: { retry: 3 }`, so the message cannot spin - it is retried at most three times and then
  // lands in fabFileChunkQueueDLQ, which alarms and is replayable. Acking instead strands the file
  // invisibly with its passages already deleted and NOTHING left to retry it, which is strictly
  // worse. A redelivery is also idempotent here: this branch has done nothing destructive, and if the
  // switch has since gone off the redelivery rebuilds the file for real.
  it('fails the delivery when the marker write keeps failing, so SQS retries instead of stranding it', async () => {
    h.fabFileUpdate.mockRejectedValue(new Error('mongo down'));

    await expect(dispatch(makeEvent(convergencePayload), {} as never, mockLogger)).rejects.toThrow('mongo down');
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('could not mark ff1'));
    // Still no destructive work, which is what makes the redelivery safe.
    expect(h.prepareFabFileChunks).not.toHaveBeenCalled();
    expect(h.fabFileFindOneAndUpdate).not.toHaveBeenCalled();
  });

  // A customer upload carries no origin and must never be halted - and must not be marked either.
  it('never touches a user upload', async () => {
    h.chunkFabfile.mockResolvedValue([]);

    await dispatch(makeEvent({ fabFileId: 'ff1', userId: 'u1' }), {} as never, mockLogger);

    expect(h.fabFileUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ notes: PAUSED_CHUNK_NOTE }));
  });
});
