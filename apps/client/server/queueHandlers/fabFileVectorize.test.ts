import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

// Mirror of fabFileChunk.test.ts, scoped to the batchId log-metadata attach. We drive the raw
// handler with a fully-vectorized FabFile so it hits the idempotency early-return right after the
// updateMetadata call - no embedding path is exercised.
vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
  // Declared, not spread from the real module: this mock exists to keep `utils`' import-time
  // Config/DB wiring out of the test. Any NEW export the handler starts importing has to be added
  // here too, or it arrives as undefined and the handler misbehaves silently.
  MARK_PAUSED_MAX_ATTEMPTS: 3,
  MARK_PAUSED_RETRY_DELAY_MS: 0, // 0 so the backoff does not add real delay to the suite
}));

const h = vi.hoisted(() => ({
  findAccessibleById: vi.fn(),
  markFailedIfNotAlready: vi.fn(),
  getVector: vi.fn(),
  getEmbedding: vi.fn(),
  updateFileStatus: vi.fn(),
  incrementCounter: vi.fn(async () => ({ failedFiles: 1, processingFailedFiles: 1 })),
  incrementCounters: vi.fn(async () => ({ failedFiles: 1, processingFailedFiles: 1 })),
  markFailureCounted: vi.fn(async () => undefined),
  claimFileStatus: vi.fn(),
  deferFailureIfRetryable: vi.fn(),
  fabFileUpdate: vi.fn(),
  advanceVectorizeProgress: vi.fn(async () => true),
  computeChunkVectorRollup: vi.fn(async () => ({ terminalChunkCount: 0, embeddedChunkCount: 0, embeddedCharCount: 0 })),
  chunkUpdate: vi.fn(),
  getAtlasIndexForModel: vi.fn(() => ({ name: 'idx', numDimensions: 3 })),
  stampChunkEmbeddingModel: vi.fn(),
  indexChunks: vi.fn(),
  selfHostOpenSearchEnabled: vi.fn(() => false),
  enforceEmbeddingSpendGate: vi.fn(async () => undefined),
  // Mirrors the real resolver's rule closely enough for the handler's branch: batch uploads and
  // tag-joined members are both lake work, everything else is not. Its own decision table is
  // pinned in resolveIngestSpendScope.test.ts.
  resolveIngestSpendScope: vi.fn(async (file: { batchId?: string }) =>
    file.batchId ? { batchId: file.batchId, dataLakeId: 'lake-1' } : null
  ),
  batchFindById: vi.fn(async () => ({ id: 'batch-1', dataLakeId: 'lake-1' })),
  batchReleaseSpend: vi.fn(async () => true),
  lakeReleaseSpend: vi.fn(async () => true),
  getSettingsValue: vi.fn(),
  organizationFindById: vi.fn(async () => null),
  recordOperationalUsage: vi.fn(async () => undefined),
  spendNotifier: vi.fn(async () => undefined),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: h.getSettingsValue },
  apiKeyRepository: {},
  dataLakeBatchRepository: {
    updateFileStatus: h.updateFileStatus,
    incrementCounter: h.incrementCounter,
    incrementCounters: h.incrementCounters,
    claimFileStatus: h.claimFileStatus,
    markFailureCounted: h.markFailureCounted,
    findById: h.batchFindById,
    releaseEmbeddingSpend: h.batchReleaseSpend,
  },
  // dataLakeRepository/scopedSettingsRepository also feed the convergence kill switch (#1676),
  // built eagerly on every message.
  dataLakeRepository: { releaseEmbeddingSpend: h.lakeReleaseSpend, findById: vi.fn() },
  scopedSettingsRepository: { findOverrides: vi.fn() },
  cacheRepository: {},
  embeddingCacheRepository: {},
  fabFileChunkRepository: {
    findById: vi.fn(),
    computeChunkVectorRollup: h.computeChunkVectorRollup,
    update: h.chunkUpdate,
  },
  fabFileRepository: {
    shareable: { findAccessibleById: h.findAccessibleById },
    markFailedIfNotAlready: h.markFailedIfNotAlready,
    update: h.fabFileUpdate,
    advanceVectorizeProgress: h.advanceVectorizeProgress,
  },
  organizationRepository: { findById: h.organizationFindById },
  usageEventRepository: {},
  User: { findById: vi.fn(async () => ({ id: 'u1' })) },
  withTransaction: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('@server/managers/fabFileManager', () => ({ getVector: h.getVector }));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: vi.fn(async () => ({})) },
  embeddingCacheService: { getEmbedding: h.getEmbedding, setEmbedding: vi.fn().mockResolvedValue(undefined) },
  fabFilesService: { stampChunkEmbeddingModel: h.stampChunkEmbeddingModel },
  recordOperationalUsage: h.recordOperationalUsage,
  dataLakeService: {
    enforceEmbeddingSpendGate: h.enforceEmbeddingSpendGate,
    resolveIngestSpendScope: h.resolveIngestSpendScope,
    // Mirror the real class's retryable flag so the handler's terminal-denial branch classifies correctly.
    EmbeddingSpendDeniedError: class EmbeddingSpendDeniedError extends Error {
      retryable: boolean;
      constructor(reason: string, options?: { retryable?: boolean }) {
        super(reason);
        this.name = 'EmbeddingSpendDeniedError';
        this.retryable = options?.retryable ?? false;
      }
    },
  },
  scopedSettingsService: { resolveScopedSetting: vi.fn(), scopeForLake: vi.fn() },
}));
vi.mock('@server/queueHandlers/dataLakeBatchProgress', () => ({
  finalizeBatchIfComplete: vi.fn(),
  isBatchComplete: vi.fn(),
  deferFailureIfRetryable: (...a: unknown[]) => h.deferFailureIfRetryable(...a),
}));
vi.mock('@server/websocket/utils', () => ({ sendToClient: vi.fn(async () => undefined) }));
vi.mock('@server/utils/dataLakeSpendNotifier', () => ({ makeDataLakeSpendNotifier: () => h.spendNotifier }));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));
vi.mock('@server/utils/errors', () => ({ NotFoundError: class NotFoundError extends Error {} }));
// Module-load zod schemas used by VectorizePayload.
vi.mock('@bike4mind/common', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/common')>('@bike4mind/common');
  return {
    SupportedEmbeddingModelSchema: z.string(),
    getEmbeddingModelCost: vi.fn(() => 0.0001),
    // Pulled from the real module rather than retyped, for the provenance vocabulary
    // convergenceProvenance.ts re-exports from common:
    // the payload schema's fail-soft `origin` and the halt rule are exactly what the kill-switch
    // tests below exercise, so a stub here would make them assert against themselves.
    WORK_ORIGINS: actual.WORK_ORIGINS,
    WorkOriginSchema: actual.WorkOriginSchema,
    CONVERGENCE_ORIGIN: actual.CONVERGENCE_ORIGIN,
    provenancePayloadShape: actual.provenancePayloadShape,
    shouldHaltConvergence: actual.shouldHaltConvergence,
  };
});
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
  getAtlasIndexForModel: h.getAtlasIndexForModel,
  FabFileChunkSearchIndex: { indexChunks: h.indexChunks },
}));
vi.mock('@bike4mind/db-core', () => ({ selfHostOpenSearchEnabled: h.selfHostOpenSearchEnabled }));
vi.mock('sst', () => ({ Resource: new Proxy({}, { get: () => new Proxy({}, { get: () => 'mock' }) }) }));

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), updateMetadata: vi.fn() } as never;

import { fabFileChunkRepository, User } from '@bike4mind/database';
import { sendToClient } from '@server/websocket/utils';
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

describe('fabFileVectorize handler - convergence kill switch (#1676)', () => {
  // A partially-vectorized file passes the already-vectorized idempotency guard and reaches the
  // halt check that sits just after it.
  const unvectorizedFile = (batchId?: string) => ({
    id: 'ff1',
    batchId,
    vectorized: false,
    chunkCount: 1,
    vectorizedChunkCount: 0,
  });
  const convergencePayload = { ...payload, origin: 'convergence' as const };

  beforeEach(() => {
    vi.clearAllMocks();
    h.findAccessibleById.mockResolvedValue(unvectorizedFile('batch-1'));
    h.fabFileUpdate.mockResolvedValue(undefined); // the flag-write is retried, then throws (see below)
  });

  it('flags the file and skips embedding when a convergence message hits the paused switch', async () => {
    h.getSettingsValue.mockResolvedValue(true); // PauseLakeConvergence on (global read)

    await dispatch(makeEvent(convergencePayload), {} as never, mockLogger);

    expect(h.fabFileUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ff1', chunkStallReason: 'vectorizePaused', isVectorizing: false })
    );
    // Embedding is gated: neither the chunk load nor the provider call runs.
    expect(fabFileChunkRepository.findById as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(h.getVector).not.toHaveBeenCalled();
  });

  it('never halts user work even when the switch is on, and does not flag the file', async () => {
    h.getSettingsValue.mockResolvedValue(true);
    (fabFileChunkRepository.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null); // no chunks -> early return

    await dispatch(makeEvent(payload), {} as never, mockLogger); // payload has no origin -> user

    // User work short-circuits before any settings read; the file is never flagged paused.
    expect(h.getSettingsValue).not.toHaveBeenCalled();
    expect(h.fabFileUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ chunkStallReason: 'vectorizePaused' }));
  });

  // The marker is what makes an abandoned chunked-but-unvectorized file ENUMERABLE - the rebuild
  // door selects on it - so losing the write and acking anyway leaves a file that reports as "still
  // indexing" forever with no repair offered. QA measured this arm as the dominant one (~33 to 1
  // against the chunk arm), so it is the one most worth making durable.
  it('retries the flag-write and acks once it succeeds', async () => {
    h.getSettingsValue.mockResolvedValue(true);
    h.fabFileUpdate.mockRejectedValueOnce(new Error('pool timeout')).mockResolvedValueOnce(undefined);

    await expect(dispatch(makeEvent(convergencePayload), {} as never, mockLogger)).resolves.toBeUndefined();
    expect(h.fabFileUpdate).toHaveBeenCalledTimes(2);
  });

  // fabFileVectorizeQueue sets `dlq: { retry: 3 }` with a 6-minute visibility timeout and its DLQ is
  // in DLQ_DESCRIPTORS + dlqRegistry, so this cannot spin - it retries at most three times, then
  // alarms and is replayable. A redelivery is idempotent: nothing destructive has run, and the
  // already-vectorized guard upstream means a resumed file is never re-embedded.
  it('fails the delivery when the flag-write keeps failing, rather than stranding it unenumerable', async () => {
    h.getSettingsValue.mockResolvedValue(true);
    h.fabFileUpdate.mockRejectedValue(new Error('mongo down'));

    await expect(dispatch(makeEvent(convergencePayload), {} as never, mockLogger)).rejects.toThrow('mongo down');
    // Still no embedding work, which is what makes the redelivery safe.
    expect(h.getVector).not.toHaveBeenCalled();
  });

  it('lets convergence work proceed when the switch is off', async () => {
    h.getSettingsValue.mockResolvedValue(false);
    (fabFileChunkRepository.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null); // no valid chunks -> early return after the halt gate

    await dispatch(makeEvent(convergencePayload), {} as never, mockLogger);

    expect(h.fabFileUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ chunkStallReason: 'vectorizePaused' }));
    // Passed the gate and reached chunk loading.
    expect(fabFileChunkRepository.findById as ReturnType<typeof vi.fn>).toHaveBeenCalled();
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

describe('fabFileVectorize handler - spend gate', () => {
  const unvectorizedFile = (batchId?: string) => ({
    id: 'ff1',
    batchId,
    vectorized: false,
    chunkCount: 1,
    vectorizedChunkCount: 0,
  });
  // Same shape the mocked services module produces - the handler classifies via instanceof.
  const denial = async (reason: string, retryable: boolean) => {
    const { dataLakeService } = await import('@bike4mind/services');
    return new dataLakeService.EmbeddingSpendDeniedError(reason, { retryable });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (fabFileChunkRepository.findById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'c1',
      text: 'hello world',
      tokenCount: 5,
    });
    h.getEmbedding.mockResolvedValue(null); // cache miss -> the gate is in play
    h.markFailedIfNotAlready.mockResolvedValue(true);
    // clearAllMocks resets calls but not replaced implementations - re-grant so a
    // denial mocked in one test can never leak into later describes.
    h.enforceEmbeddingSpendGate.mockResolvedValue(undefined);
    h.resolveIngestSpendScope.mockImplementation(async (file: { batchId?: string }) =>
      file.batchId ? { batchId: file.batchId, dataLakeId: 'lake-1' } : null
    );
  });

  it('runs the gate for a data-lake file before any provider call, metering its tokens', async () => {
    h.findAccessibleById.mockResolvedValue(unvectorizedFile('batch-1'));
    h.getVector.mockResolvedValue([0.1, 0.2, 0.3]);

    await dispatch(makeEvent(payload), {} as never, mockLogger);

    expect(h.enforceEmbeddingSpendGate).toHaveBeenCalledWith(
      expect.objectContaining({ batchId: 'batch-1', dataLakeId: 'lake-1', estimatedTokens: 5 })
    );
  });

  it('runs the gate for a tag-joined lake member that carries NO batchId', async () => {
    // The population a bulk rebuild is largest for: membership is by tag, so batchId is absent and
    // the pre-#1743 gate skipped these files entirely - unthrottled and unmetered.
    h.findAccessibleById.mockResolvedValue(unvectorizedFile(undefined));
    h.resolveIngestSpendScope.mockResolvedValue({ dataLakeId: 'lake-9' });
    h.getVector.mockResolvedValue([0.1, 0.2, 0.3]);

    await dispatch(makeEvent(payload), {} as never, mockLogger);

    expect(h.enforceEmbeddingSpendGate).toHaveBeenCalledWith(
      expect.objectContaining({ batchId: undefined, dataLakeId: 'lake-9', estimatedTokens: 5 })
    );
  });

  it('skips the gate entirely for a file that belongs to no lake', async () => {
    h.findAccessibleById.mockResolvedValue(unvectorizedFile(undefined));
    h.getVector.mockResolvedValue([0.1, 0.2, 0.3]);

    await dispatch(makeEvent(payload), {} as never, mockLogger);

    expect(h.enforceEmbeddingSpendGate).not.toHaveBeenCalled();
  });

  it('wires the spend notifier into the gate call', async () => {
    h.findAccessibleById.mockResolvedValue(unvectorizedFile('batch-1'));
    h.getVector.mockResolvedValue([0.1, 0.2, 0.3]);

    await dispatch(makeEvent(payload), {} as never, mockLogger);

    expect(h.enforceEmbeddingSpendGate).toHaveBeenCalledWith(expect.objectContaining({ notify: h.spendNotifier }));
  });

  it('a terminal denial accounts the failure immediately and CONSUMES the message', async () => {
    h.findAccessibleById.mockResolvedValue(unvectorizedFile('batch-1'));
    h.enforceEmbeddingSpendGate.mockRejectedValueOnce(await denial('budget exhausted', false));

    // Resolves (no rethrow): the message must not ride SQS retries into the DLQ.
    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).resolves.toBeUndefined();

    expect(h.deferFailureIfRetryable).not.toHaveBeenCalled();
    expect(h.markFailedIfNotAlready).toHaveBeenCalledWith('ff1', expect.stringContaining('budget exhausted'));
    expect(h.getVector).not.toHaveBeenCalled();
  });

  it('releases the reservation from the run and lake meters when the provider call fails', async () => {
    h.findAccessibleById.mockResolvedValue(unvectorizedFile('batch-1'));
    h.getVector.mockRejectedValueOnce(new Error('openai 500'));

    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow('openai 500');

    // getEmbeddingModelCost is mocked to 0.0001 USD -> ceil(100) microUSD for the message.
    expect(h.batchReleaseSpend).toHaveBeenCalledWith('batch-1', 100);
    expect(h.lakeReleaseSpend).toHaveBeenCalledWith('lake-1', 100);
  });

  it('does NOT release when embeddings succeeded and a later step fails (money truly spent)', async () => {
    h.findAccessibleById.mockResolvedValue(unvectorizedFile('batch-1'));
    h.getVector.mockResolvedValue([0.1, 0.2, 0.3]);
    h.chunkUpdate.mockRejectedValueOnce(new Error('mongo write failed'));

    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow();

    expect(h.batchReleaseSpend).not.toHaveBeenCalled();
    expect(h.lakeReleaseSpend).not.toHaveBeenCalled();
  });

  it('a release failure is logged, never masks the provider error', async () => {
    h.findAccessibleById.mockResolvedValue(unvectorizedFile('batch-1'));
    h.getVector.mockRejectedValueOnce(new Error('openai 500'));
    h.batchReleaseSpend.mockRejectedValueOnce(new Error('mongo down'));

    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow('openai 500');
  });

  it('a retryable (rate-limit) denial keeps the normal SQS retry path', async () => {
    h.findAccessibleById.mockResolvedValue(unvectorizedFile('batch-1'));
    h.enforceEmbeddingSpendGate.mockRejectedValueOnce(await denial('rate limit stayed exhausted', true));
    h.deferFailureIfRetryable.mockResolvedValue(true);

    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow();
    expect(h.deferFailureIfRetryable).toHaveBeenCalled();
    expect(h.markFailedIfNotAlready).not.toHaveBeenCalled();
  });
});

describe('fabFileVectorize handler - usage ledger', () => {
  const unvectorizedFile = (batchId?: string) => ({
    id: 'ff1',
    batchId,
    vectorized: false,
    chunkCount: 1,
    vectorizedChunkCount: 0,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (fabFileChunkRepository.findById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'c1',
      text: 'hello world',
      tokenCount: 5,
    });
    h.getEmbedding.mockResolvedValue(null); // cache miss -> the ledger call is in play
    h.enforceEmbeddingSpendGate.mockResolvedValue(undefined);
    h.getVector.mockResolvedValue([0.1, 0.2, 0.3]);
  });

  it('records a UsageEvent attributed to the lake, bypassing credit billing', async () => {
    h.findAccessibleById.mockResolvedValue(unvectorizedFile('batch-1'));

    await dispatch(makeEvent(payload), {} as never, mockLogger);

    expect(h.recordOperationalUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        dataLakeId: 'lake-1',
        feature: 'embedding',
        bypassCreditBilling: true,
        inputTokens: 5,
        // getEmbeddingModelCost is mocked as a flat 0.0001 USD return (see spend-gate describe
        // above) -> ceil(0.0001*1e6)/1e6 = 0.0001.
        costUsd: 0.0001,
      }),
      expect.anything()
    );
  });

  it('never records for a turn-attached file (no batchId, no lake)', async () => {
    h.findAccessibleById.mockResolvedValue(unvectorizedFile(undefined));

    await dispatch(makeEvent(payload), {} as never, mockLogger);

    expect(h.recordOperationalUsage).not.toHaveBeenCalled();
  });

  it('never records on a cache hit (no spend occurred)', async () => {
    h.findAccessibleById.mockResolvedValue(unvectorizedFile('batch-1'));
    h.getEmbedding.mockResolvedValue([0.1, 0.2, 0.3]); // cache hit

    await dispatch(makeEvent(payload), {} as never, mockLogger);

    expect(h.recordOperationalUsage).not.toHaveBeenCalled();
  });

  it('a recordOperationalUsage failure never fails the vectorize run', async () => {
    h.findAccessibleById.mockResolvedValue(unvectorizedFile('batch-1'));
    h.recordOperationalUsage.mockRejectedValueOnce(new Error('ledger down'));

    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).resolves.toBeUndefined();
  });

  it('an organization lookup failure never fails the vectorize run (the embeddings are already paid for by this point)', async () => {
    h.findAccessibleById.mockResolvedValue(unvectorizedFile('batch-1'));
    // The default user fixture has no organizationId, which skips the lookup branch entirely -
    // this test needs it set so organizationRepository.findById is actually reached and rejected.
    (User.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'u1', organizationId: 'org-1' });
    h.organizationFindById.mockRejectedValueOnce(new Error('org lookup down'));

    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).resolves.toBeUndefined();
    expect(h.organizationFindById).toHaveBeenCalledWith('org-1');
    // The ledger write still happens (organization just resolves to null), so this is not
    // silently skipped along with the failure - it degrades gracefully instead.
    expect(h.recordOperationalUsage).toHaveBeenCalledWith(
      expect.objectContaining({ organization: null }),
      expect.anything()
    );
  });
});

describe('fabFileVectorize handler - notification failures are non-fatal (human review)', () => {
  // This message must actually complete vectorization DURING this call (not already be
  // fully vectorized) so it reaches the isFileVectorized branch at lines 233-253 rather than
  // returning early at the top-of-handler idempotency check (lines 81-88). A throw from the
  // vectorize-complete push there must not stop the batch claim/increment that follows it:
  // the file is already persisted vectorized:true by that point, so a stranded claim here
  // would never get another chance (the next retry hits the idempotency early-return).
  const unvectorizedFile = (batchId?: string) => ({
    id: 'ff1',
    batchId,
    vectorized: false,
    chunkCount: 1,
    vectorizedChunkCount: 0,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (fabFileChunkRepository.findById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'c1',
      text: 'hello world',
      tokenCount: 5,
    });
    h.getEmbedding.mockResolvedValue(null);
    h.getVector.mockResolvedValue([0.1, 0.2, 0.3]);
    h.computeChunkVectorRollup.mockResolvedValue({
      terminalChunkCount: 1,
      embeddedChunkCount: 0,
      embeddedCharCount: 0,
    });
    h.claimFileStatus.mockResolvedValue(true);
    h.incrementCounter.mockResolvedValue({ vectorizedFiles: 1, failedFiles: 0, totalFiles: 1 });
  });

  it('a rejecting sendToClient does not prevent the batch claim/increment from completing', async () => {
    h.findAccessibleById.mockResolvedValue(unvectorizedFile('batch-1'));
    (sendToClient as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('socket gone'));

    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).resolves.toBeUndefined();

    expect(h.claimFileStatus).toHaveBeenCalledWith('batch-1', 'ff1', ['chunking', 'uploaded', 'pending'], 'complete');
    expect(h.incrementCounter).toHaveBeenCalledWith('batch-1', 'vectorizedFiles');
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
    expect(h.incrementCounters).not.toHaveBeenCalled();
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

  it('when not deferred (final attempt), accounts the failure into both counters atomically', async () => {
    h.findAccessibleById.mockResolvedValue(unvectorizedFile('batch-1'));
    h.getVector.mockRejectedValue(new Error(RATE_LIMIT_ERR));
    h.deferFailureIfRetryable.mockResolvedValue(false);

    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow(RATE_LIMIT_ERR);
    expect(h.markFailedIfNotAlready).toHaveBeenCalledWith('ff1', RATE_LIMIT_ERR);
    expect(h.updateFileStatus).toHaveBeenCalledWith('batch-1', 'ff1', 'failed', RATE_LIMIT_ERR);
    // One atomic call for both counters, so a crash between two sequential $inc writes can
    // never misclassify a processing failure as an upload one (#1412).
    expect(h.incrementCounters).toHaveBeenCalledWith('batch-1', { failedFiles: 1, processingFailedFiles: 1 });
    // Raised only once the guarded $inc has landed - updateFileStatus already stamped it false, so
    // revertFileFailure can attribute a decrement to this entry rather than another file's.
    expect(h.markFailureCounted).toHaveBeenCalledWith('batch-1', 'ff1', true);
  });

  it('leaves the entry uncounted when the guarded failure $inc was swallowed', async () => {
    h.findAccessibleById.mockResolvedValue(unvectorizedFile('batch-1'));
    h.getVector.mockRejectedValue(new Error(RATE_LIMIT_ERR));
    h.deferFailureIfRetryable.mockResolvedValue(false);
    h.incrementCounters.mockResolvedValue(null); // batch already terminal

    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow(RATE_LIMIT_ERR);
    expect(h.markFailureCounted).not.toHaveBeenCalled();
  });

  it('a deferred failure followed by a successful retry never touches failedFiles', async () => {
    h.findAccessibleById.mockResolvedValue(unvectorizedFile('batch-1'));
    h.getVector.mockRejectedValue(new Error(RATE_LIMIT_ERR));
    h.deferFailureIfRetryable.mockResolvedValue(true);
    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow(RATE_LIMIT_ERR);
    expect(h.incrementCounters).not.toHaveBeenCalled();

    vi.clearAllMocks();
    (fabFileChunkRepository.findById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'c1',
      text: 'hello world',
      tokenCount: 5,
    });
    h.getEmbedding.mockResolvedValue(null);
    h.findAccessibleById.mockResolvedValue(unvectorizedFile('batch-1'));
    h.getVector.mockResolvedValue([0.1, 0.2, 0.3]);
    h.computeChunkVectorRollup.mockResolvedValue({
      terminalChunkCount: 1,
      embeddedChunkCount: 0,
      embeddedCharCount: 0,
    });
    h.claimFileStatus.mockResolvedValue(true);
    h.incrementCounter.mockResolvedValue({ vectorizedFiles: 1, failedFiles: 0, totalFiles: 1 });

    await dispatch(makeEvent(payload), {} as never, mockLogger);
    expect(h.claimFileStatus).toHaveBeenCalledWith('batch-1', 'ff1', ['chunking', 'uploaded', 'pending'], 'complete');
    expect(h.incrementCounter).toHaveBeenCalledWith('batch-1', 'vectorizedFiles');
    expect(h.incrementCounters).not.toHaveBeenCalled();
    expect(h.updateFileStatus).not.toHaveBeenCalledWith('batch-1', 'ff1', 'failed', expect.anything());
  });
});

describe('fabFileVectorize handler - embeddingModel discriminator stamp', () => {
  const unvectorizedFile = (batchId?: string) => ({
    id: 'ff1',
    batchId,
    vectorized: false,
    chunkCount: 1,
    vectorizedChunkCount: 0,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    h.getAtlasIndexForModel.mockReturnValue({ name: 'idx', numDimensions: 3 });
    (fabFileChunkRepository.findById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'c1',
      text: 'hello world',
      tokenCount: 5,
    });
    h.getEmbedding.mockResolvedValue(null);
    h.computeChunkVectorRollup.mockResolvedValue({
      terminalChunkCount: 1,
      embeddedChunkCount: 0,
      embeddedCharCount: 0,
    });
  });

  it('stamps the chunk embeddingModel once the whole file is fully vectorized', async () => {
    h.findAccessibleById.mockResolvedValue(unvectorizedFile(undefined));
    h.getVector.mockResolvedValue([0.1, 0.2, 0.3]);

    await dispatch(makeEvent(payload), {} as never, mockLogger);

    expect(h.stampChunkEmbeddingModel).toHaveBeenCalledWith(
      'ff1',
      'text-embedding-3-small',
      expect.objectContaining({ db: expect.anything() }),
      { vectorized: true, vectorizedChunkCount: 1, isVectorizing: false, embeddedChunkCount: 0, embeddedCharCount: 0 }
    );
  });

  it('throws before writing a chunk vector whose width does not match the model Atlas index', async () => {
    h.findAccessibleById.mockResolvedValue(unvectorizedFile(undefined));
    h.getVector.mockResolvedValue([0.1, 0.2, 0.3]);
    h.getAtlasIndexForModel.mockReturnValue({ name: 'idx', numDimensions: 5 });

    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).rejects.toThrow(/dimensions/);

    expect(h.chunkUpdate).not.toHaveBeenCalled();
    expect(h.stampChunkEmbeddingModel).not.toHaveBeenCalled();
  });
});

describe('fabFileVectorize handler - self-host OpenSearch dual-write', () => {
  const unvectorizedFile = (batchId?: string) => ({
    id: 'ff1',
    batchId,
    vectorized: false,
    chunkCount: 1,
    vectorizedChunkCount: 0,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    h.getAtlasIndexForModel.mockReturnValue({ name: 'idx', numDimensions: 3 });
    (fabFileChunkRepository.findById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'c1',
      text: 'hello world',
      tokenCount: 5,
    });
    h.getEmbedding.mockResolvedValue(null);
    h.computeChunkVectorRollup.mockResolvedValue({
      terminalChunkCount: 1,
      embeddedChunkCount: 0,
      embeddedCharCount: 0,
    });
    h.findAccessibleById.mockResolvedValue(unvectorizedFile(undefined));
    h.getVector.mockResolvedValue([0.1, 0.2, 0.3]);
  });

  it('indexes the vectorized chunks when self-host OpenSearch is enabled', async () => {
    h.selfHostOpenSearchEnabled.mockReturnValue(true);
    h.indexChunks.mockResolvedValue(undefined);

    await dispatch(makeEvent(payload), {} as never, mockLogger);

    expect(h.indexChunks).toHaveBeenCalledTimes(1);
    expect(h.chunkUpdate).toHaveBeenCalled();
  });

  it('stamps embeddingModel onto the chunks passed to indexChunks - not persisted per-chunk in Mongo yet at this point', async () => {
    h.selfHostOpenSearchEnabled.mockReturnValue(true);
    h.indexChunks.mockResolvedValue(undefined);

    await dispatch(makeEvent(payload), {} as never, mockLogger);

    const indexedChunks = h.indexChunks.mock.calls[0][0];
    expect(indexedChunks).toEqual([expect.objectContaining({ id: 'c1', embeddingModel: 'text-embedding-3-small' })]);
  });

  it('never calls indexChunks when self-host OpenSearch is disabled', async () => {
    h.selfHostOpenSearchEnabled.mockReturnValue(false);

    await dispatch(makeEvent(payload), {} as never, mockLogger);

    expect(h.indexChunks).not.toHaveBeenCalled();
  });

  it('fails open on an indexing error - the Mongo write and stamp still complete, no throw', async () => {
    h.selfHostOpenSearchEnabled.mockReturnValue(true);
    h.indexChunks.mockRejectedValue(new Error('cluster unreachable'));

    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).resolves.toBeUndefined();

    expect(h.chunkUpdate).toHaveBeenCalled();
    expect(h.stampChunkEmbeddingModel).toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalled();
    expect(h.markFailedIfNotAlready).not.toHaveBeenCalled();
  });

  it('persists retrievalIndexModel with the chunk vector, so index residency does not wait on the stamp', async () => {
    h.selfHostOpenSearchEnabled.mockReturnValue(true);
    h.indexChunks.mockResolvedValue(undefined);

    await dispatch(makeEvent(payload), {} as never, mockLogger);

    expect(h.chunkUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1', retrievalIndexModel: 'text-embedding-3-small' })
    );
  });

  it('leaves retrievalIndexModel unwritten when self-host OpenSearch is disabled', async () => {
    h.selfHostOpenSearchEnabled.mockReturnValue(false);

    await dispatch(makeEvent(payload), {} as never, mockLogger);

    expect(h.chunkUpdate.mock.calls[0][0]).not.toHaveProperty('retrievalIndexModel');
  });

  // The bug: this message's chunks reach OpenSearch, then the file never finishes - the spend gate
  // denies a later message terminally, SQS retries run out, or a purge lands mid-flight - so
  // stampChunkEmbeddingModel never runs. Every removal path resolves the index to hit from the
  // chunk rows, so residency has to be on them already or those documents are unreachable forever.
  it('records residency on a message that leaves the file short of complete, with no stamp', async () => {
    h.selfHostOpenSearchEnabled.mockReturnValue(true);
    h.indexChunks.mockResolvedValue(undefined);
    h.findAccessibleById.mockResolvedValue({ ...unvectorizedFile(undefined), chunkCount: 5 });
    h.computeChunkVectorRollup.mockResolvedValue({
      terminalChunkCount: 1,
      embeddedChunkCount: 1,
      embeddedCharCount: 11,
    });

    await dispatch(makeEvent(payload), {} as never, mockLogger);

    expect(h.stampChunkEmbeddingModel).not.toHaveBeenCalled();
    expect(h.chunkUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1', retrievalIndexModel: 'text-embedding-3-small' })
    );
  });

  it('a terminal spend denial on a later message is consumed, leaving the earlier residency in place', async () => {
    h.selfHostOpenSearchEnabled.mockReturnValue(true);
    h.indexChunks.mockResolvedValue(undefined);
    // batchId present: the spend gate is the data-lake path only.
    h.findAccessibleById.mockResolvedValue({ ...unvectorizedFile('batch-1'), chunkCount: 5 });
    h.computeChunkVectorRollup.mockResolvedValue({
      terminalChunkCount: 1,
      embeddedChunkCount: 1,
      embeddedCharCount: 11,
    });

    await dispatch(makeEvent(payload), {} as never, mockLogger);

    const { dataLakeService } = await import('@bike4mind/services');
    h.enforceEmbeddingSpendGate.mockRejectedValueOnce(
      new dataLakeService.EmbeddingSpendDeniedError('lake cap reached', { retryable: false })
    );

    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('denied by spend gate'));
    expect(h.stampChunkEmbeddingModel).not.toHaveBeenCalled();
    // Only the first message wrote chunks; the residency it recorded is all a later removal has.
    expect(h.chunkUpdate).toHaveBeenCalledTimes(1);
    expect(h.chunkUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1', retrievalIndexModel: 'text-embedding-3-small' })
    );
  });
});

describe('fabFileVectorize handler - partial rollup write is guarded', () => {
  // Two messages for one file. The one that finishes last stamps the terminal state; the other
  // is still holding the smaller rollup it measured earlier. That late write must not land as a
  // plain update, or the file sits below chunkCount with isVectorizing on and drops out of
  // retrieval permanently.
  const partialFile = () => ({
    id: 'ff1',
    vectorized: false,
    chunkCount: 10,
    vectorizedChunkCount: 0,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    h.getAtlasIndexForModel.mockReturnValue({ name: 'idx', numDimensions: 3 });
    (fabFileChunkRepository.findById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'c1',
      text: 'hello world',
      tokenCount: 5,
    });
    h.getEmbedding.mockResolvedValue(null);
    h.getVector.mockResolvedValue([0.1, 0.2, 0.3]);
    h.findAccessibleById.mockResolvedValue(partialFile());
  });

  it('routes a not-complete rollup through the guarded advance, never a plain update', async () => {
    h.computeChunkVectorRollup.mockResolvedValue({
      terminalChunkCount: 8,
      embeddedChunkCount: 8,
      embeddedCharCount: 80,
    });
    h.advanceVectorizeProgress.mockResolvedValue(true);

    await dispatch(makeEvent(payload), {} as never, mockLogger);

    expect(h.advanceVectorizeProgress).toHaveBeenCalledWith('ff1', 8, {
      embeddedChunkCount: 8,
      embeddedCharCount: 80,
    });
    expect(h.fabFileUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ isVectorizing: true }));
    expect(h.stampChunkEmbeddingModel).not.toHaveBeenCalled();
  });

  it('completes normally when the guard rejects the stale rollup', async () => {
    h.computeChunkVectorRollup.mockResolvedValue({
      terminalChunkCount: 8,
      embeddedChunkCount: 8,
      embeddedCharCount: 80,
    });
    h.advanceVectorizeProgress.mockResolvedValue(false);

    await expect(dispatch(makeEvent(payload), {} as never, mockLogger)).resolves.toBeUndefined();

    expect(h.markFailedIfNotAlready).not.toHaveBeenCalled();
    expect(h.stampChunkEmbeddingModel).not.toHaveBeenCalled();
  });
});
