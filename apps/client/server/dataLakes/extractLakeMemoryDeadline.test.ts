/**
 * Deadline-guard tests for `extractLakeMemoryForBatch`.
 *
 * The doc cap is an estimate of what fits in the Lambda; the deadline is the enforcement. Without it a
 * large lake is killed mid-document, the handler rethrows, SQS redelivers (retry: 2 then DLQ), and every
 * redelivery re-bills the whole lake - the LLM call for a doc runs before the ledger de-dup that would
 * have made it free. These tests pin that the run YIELDS instead, keeping what it already wrote.
 *
 * Lives in its own file rather than extractLakeMemory.test.ts because that one covers the pure
 * `evidenceTierForDoc` and deliberately mocks nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findByIdMock = vi.fn();
const findIdsByDataLakeTagMock = vi.fn();
const findAllByIdsMock = vi.fn();
const findTextsByFabFileIdMock = vi.fn();
const evaluateMock = vi.fn();
const appendMock = vi.fn();
const claimLakeMemoryExtractionMock = vi.fn();
const releaseLakeMemoryExtractionMock = vi.fn();
const setLakeMemoryCursorMock = vi.fn();

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: vi.fn().mockResolvedValue(undefined) },
  apiKeyRepository: {},
  dataLakeRepository: {
    findById: (...a: unknown[]) => findByIdMock(...a),
    claimLakeMemoryExtraction: (...a: unknown[]) => claimLakeMemoryExtractionMock(...a),
    releaseLakeMemoryExtraction: (...a: unknown[]) => releaseLakeMemoryExtractionMock(...a),
    setLakeMemoryCursor: (...a: unknown[]) => setLakeMemoryCursorMock(...a),
  },
  fabFileChunkRepository: { findTextsByFabFileId: (...a: unknown[]) => findTextsByFabFileIdMock(...a) },
  fabFileRepository: {
    findIdsByDataLakeTag: (...a: unknown[]) => findIdsByDataLakeTagMock(...a),
    findAllByIds: (...a: unknown[]) => findAllByIdsMock(...a),
  },
}));
vi.mock('@bike4mind/common', () => ({
  MEMENTO_EMBEDDING_MODEL: 'text-embedding-3-small',
  toMementoVector: (v: number[]) => v,
}));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) },
  dataLakeService: { lakeMembershipScope: () => 'datalake:test' },
  LakeMemoryExtractionService: class {
    evaluate = (...a: unknown[]) => evaluateMock(...a);
  },
}));
// `resolveEmbeddingConfig` is called unconditionally, so it must return a real shape. Reporting
// `missing: true` takes the documented no-key path: facts are written WITHOUT vectors, which keeps these
// tests off the embedding provider entirely while still exercising the append.
vi.mock('@bike4mind/fab-pipeline', () => ({
  EmbeddingFactory: { create: vi.fn() },
  getProviderFromModel: () => 'openai',
  resolveEmbeddingConfig: () => ({ config: undefined, missing: true }),
}));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));
vi.mock('@server/memory/mementoLedgerMirror', () => ({
  createLedgerAppendSession: async () => ({ append: (...a: unknown[]) => appendMock(...a) }),
}));

const { extractLakeMemoryForBatch } = await import('./extractLakeMemory');

const makeLogger = () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), log: vi.fn(), debug: vi.fn() });

/** N live docs, each with readable text and one extractable fact. */
const seedLake = (docCount: number) => {
  findByIdMock.mockResolvedValue({ id: 'lake-1', createdByUserId: 'owner-1', datalakeTag: 'datalake:test' });
  const ids = Array.from({ length: docCount }, (_, i) => `doc-${i}`);
  findIdsByDataLakeTagMock.mockResolvedValue(ids);
  findAllByIdsMock.mockResolvedValue(ids.map(id => ({ id, fileName: `${id}.md`, tags: [] })));
  findTextsByFabFileIdMock.mockResolvedValue([{ text: 'some durable reference text' }]);
  evaluateMock.mockResolvedValue([{ fact: 'the X-200 ships with 36 units' }]);
};

describe('extractLakeMemoryForBatch deadline guard (#1440)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Win the per-lake extraction lease by default; the concurrency-skip case overrides this.
    claimLakeMemoryExtractionMock.mockResolvedValue(true);
    // release/setCursor return promises - the producer awaits (and .catch-es) them.
    releaseLakeMemoryExtractionMock.mockResolvedValue(undefined);
    setLakeMemoryCursorMock.mockResolvedValue(undefined);
  });

  it('processes every doc when there is plenty of time left', async () => {
    seedLake(5);
    const logger = makeLogger();

    const result = await extractLakeMemoryForBatch(
      { dataLakeId: 'lake-1', getRemainingTimeInMillis: () => 10 * 60_000 },
      logger as never
    );

    expect(result.docsProcessed).toBe(5);
    expect(result.hasMore).toBe(false);
    expect(appendMock).toHaveBeenCalledTimes(5);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('ran out of time'));
    // Releases the lease it claimed.
    expect(releaseLakeMemoryExtractionMock).toHaveBeenCalledTimes(1);
  });

  it('stops cleanly, keeps what it wrote, and defers the remainder to a continuation when time runs low', async () => {
    // 10 docs, but the clock reports "under the buffer" from the third check onward. The run must yield
    // rather than throw: the two docs already folded stay in the ledger, and the rest are NOT lost - a
    // cursor is persisted and hasMore signals the handler to re-enqueue a continuation.
    seedLake(10);
    const logger = makeLogger();
    let call = 0;
    const remaining = () => (++call <= 2 ? 10 * 60_000 : 1_000);

    const result = await extractLakeMemoryForBatch(
      { dataLakeId: 'lake-1', getRemainingTimeInMillis: remaining },
      logger as never
    );

    expect(result.docsProcessed).toBe(2);
    expect(result.hasMore).toBe(true);
    expect(appendMock).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ran out of time after 2/10 docs'));
    // The cursor resumes from the last doc ATTEMPTED (doc index 1), not the cap boundary.
    expect(setLakeMemoryCursorMock).toHaveBeenCalledWith('lake-1', 'doc-1');
  });

  it('falls back to the wall clock when the Lambda clock reports a non-finite value', async () => {
    // NaN is not nullish, and every comparison against it is false - so without an explicit finite check
    // the guard would be silently disabled rather than falling back.
    seedLake(4);
    const logger = makeLogger();
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(0).mockReturnValue(10 * 60_000);

    const result = await extractLakeMemoryForBatch(
      { dataLakeId: 'lake-1', getRemainingTimeInMillis: () => Number.NaN },
      logger as never
    );

    expect(result.docsProcessed).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ran out of time'));
    nowSpy.mockRestore();
  });

  it('does not throw when the deadline hits - a redelivery would re-bill the whole lake', async () => {
    // The whole point: yielding must be a normal return so the handler does not rethrow into SQS.
    seedLake(50);
    const logger = makeLogger();

    await expect(
      extractLakeMemoryForBatch({ dataLakeId: 'lake-1', getRemainingTimeInMillis: () => 0 }, logger as never)
    ).resolves.toEqual(expect.objectContaining({ docsProcessed: 0, factsWritten: 0 }));
    expect(evaluateMock).not.toHaveBeenCalled();
  });

  it('guards by wall clock even when no Lambda clock is supplied', async () => {
    // A caller that forgets to pass the clock must still be bounded - the fallback budget is measured
    // from entry, so the guard is never silently absent.
    seedLake(3);
    const logger = makeLogger();
    const nowSpy = vi.spyOn(Date, 'now');
    // Entry timestamp, then a value far past the 9-minute fallback budget.
    nowSpy.mockReturnValueOnce(0).mockReturnValue(10 * 60_000);

    const result = await extractLakeMemoryForBatch({ dataLakeId: 'lake-1' }, logger as never);

    expect(result.docsProcessed).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ran out of time'));
    nowSpy.mockRestore();
  });

  it('reports docsAttempted vs docsAvailableThisRun so a deadline stop is visible in the summary', async () => {
    seedLake(6);
    const logger = makeLogger();
    let call = 0;
    const remaining = () => (++call <= 1 ? 10 * 60_000 : 1_000);

    await extractLakeMemoryForBatch({ dataLakeId: 'lake-1', getRemainingTimeInMillis: remaining }, logger as never);

    expect(logger.info).toHaveBeenCalledWith(
      '[lakeMemory] extraction complete',
      expect.objectContaining({ docsAttempted: 1, docsAvailableThisRun: 6 })
    );
  });
});

describe('extractLakeMemoryForBatch continuation + concurrency guard (#1501)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimLakeMemoryExtractionMock.mockResolvedValue(true);
    releaseLakeMemoryExtractionMock.mockResolvedValue(undefined);
    setLakeMemoryCursorMock.mockResolvedValue(undefined);
  });

  it('skips the run entirely when another run already holds the lease', async () => {
    seedLake(5);
    claimLakeMemoryExtractionMock.mockResolvedValue(false);
    const logger = makeLogger();

    const result = await extractLakeMemoryForBatch(
      { dataLakeId: 'lake-1', getRemainingTimeInMillis: () => 10 * 60_000 },
      logger as never
    );

    expect(result).toEqual({ docsProcessed: 0, factsWritten: 0, hasMore: false });
    expect(evaluateMock).not.toHaveBeenCalled();
    // Nothing to release - it never won the claim.
    expect(releaseLakeMemoryExtractionMock).not.toHaveBeenCalled();
  });

  it('signals hasMore and persists the 100th doc as the cursor when the doc cap is hit', async () => {
    // Zero-padded ids so lexicographic order == numeric order, making the keyset boundary deterministic.
    findByIdMock.mockResolvedValue({ id: 'lake-1', createdByUserId: 'owner-1', datalakeTag: 'datalake:test' });
    const ids = Array.from({ length: 150 }, (_, i) => `doc-${String(i).padStart(3, '0')}`);
    findIdsByDataLakeTagMock.mockResolvedValue(ids);
    findAllByIdsMock.mockResolvedValue(ids.map(id => ({ id, fileName: `${id}.md`, tags: [] })));
    findTextsByFabFileIdMock.mockResolvedValue([{ text: 'durable reference text' }]);
    evaluateMock.mockResolvedValue([{ fact: 'a durable fact' }]);
    const logger = makeLogger();

    const result = await extractLakeMemoryForBatch(
      { dataLakeId: 'lake-1', getRemainingTimeInMillis: () => 10 * 60_000 },
      logger as never
    );

    expect(result.docsProcessed).toBe(100);
    expect(result.hasMore).toBe(true);
    expect(setLakeMemoryCursorMock).toHaveBeenCalledWith('lake-1', 'doc-099');
    expect(releaseLakeMemoryExtractionMock).toHaveBeenCalledTimes(1);
  });

  it('resumes from the persisted cursor and clears it once the scan reaches the end', async () => {
    // Cursor set to doc-1, so only doc-2..doc-4 remain and all fit this run -> the scan completes and
    // the cursor is cleared so the next finalize re-scans the whole lake.
    findByIdMock.mockResolvedValue({
      id: 'lake-1',
      createdByUserId: 'owner-1',
      datalakeTag: 'datalake:test',
      lakeMemoryCursor: 'doc-1',
    });
    const ids = ['doc-0', 'doc-1', 'doc-2', 'doc-3', 'doc-4'];
    findIdsByDataLakeTagMock.mockResolvedValue(ids);
    findAllByIdsMock.mockResolvedValue(ids.map(id => ({ id, fileName: `${id}.md`, tags: [] })));
    findTextsByFabFileIdMock.mockResolvedValue([{ text: 'durable reference text' }]);
    evaluateMock.mockResolvedValue([{ fact: 'a durable fact' }]);
    const logger = makeLogger();

    const result = await extractLakeMemoryForBatch(
      { dataLakeId: 'lake-1', getRemainingTimeInMillis: () => 10 * 60_000 },
      logger as never
    );

    // doc-0 and doc-1 are skipped (at or before the cursor); only the 3 docs after it are processed.
    expect(result.docsProcessed).toBe(3);
    expect(result.hasMore).toBe(false);
    expect(appendMock).toHaveBeenCalledTimes(3);
    expect(setLakeMemoryCursorMock).toHaveBeenCalledWith('lake-1', null);
  });

  it('reads the continuation cursor from the post-claim snapshot, not the pre-claim read', async () => {
    // The pre-claim findById can be stale: a run that just released the lease may have advanced the
    // cursor in the window before this run wins the claim. Resuming from the stale value would re-scan
    // (and re-bill) an already-covered slice. Pre-claim read reports cursor doc-0; the post-claim read
    // reports the advanced doc-3, and the run must honor the latter.
    const ids = ['doc-0', 'doc-1', 'doc-2', 'doc-3', 'doc-4'];
    findIdsByDataLakeTagMock.mockResolvedValue(ids);
    findAllByIdsMock.mockResolvedValue(ids.map(id => ({ id, fileName: `${id}.md`, tags: [] })));
    findTextsByFabFileIdMock.mockResolvedValue([{ text: 'durable reference text' }]);
    evaluateMock.mockResolvedValue([{ fact: 'a durable fact' }]);
    findByIdMock
      .mockResolvedValueOnce({
        id: 'lake-1',
        createdByUserId: 'owner-1',
        datalakeTag: 'datalake:test',
        lakeMemoryCursor: 'doc-0',
      })
      .mockResolvedValueOnce({
        id: 'lake-1',
        createdByUserId: 'owner-1',
        datalakeTag: 'datalake:test',
        lakeMemoryCursor: 'doc-3',
      });
    const logger = makeLogger();

    const result = await extractLakeMemoryForBatch(
      { dataLakeId: 'lake-1', getRemainingTimeInMillis: () => 10 * 60_000 },
      logger as never
    );

    // Post-claim cursor doc-3 leaves only doc-4; the stale doc-0 would have reprocessed doc-1..doc-4.
    expect(result.docsProcessed).toBe(1);
    expect(appendMock).toHaveBeenCalledTimes(1);
  });

  it('releases the lease even when every doc throws mid-run', async () => {
    seedLake(3);
    evaluateMock.mockRejectedValue(new Error('LLM 500'));
    const logger = makeLogger();

    const result = await extractLakeMemoryForBatch(
      { dataLakeId: 'lake-1', getRemainingTimeInMillis: () => 10 * 60_000 },
      logger as never
    );

    // Each doc failed and was skipped, but the run returned normally and released its lease (finally).
    expect(result.factsWritten).toBe(0);
    expect(releaseLakeMemoryExtractionMock).toHaveBeenCalledTimes(1);
  });
});
