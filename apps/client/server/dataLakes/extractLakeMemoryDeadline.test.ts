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
const appendFactToLedgerMock = vi.fn();

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: vi.fn().mockResolvedValue(undefined) },
  apiKeyRepository: {},
  dataLakeRepository: { findById: (...a: unknown[]) => findByIdMock(...a) },
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
  appendFactToLedger: (...a: unknown[]) => appendFactToLedgerMock(...a),
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
  });

  it('processes every doc when there is plenty of time left', async () => {
    seedLake(5);
    const logger = makeLogger();

    const result = await extractLakeMemoryForBatch(
      { dataLakeId: 'lake-1', getRemainingTimeInMillis: () => 10 * 60_000 },
      logger as never
    );

    expect(result.docsProcessed).toBe(5);
    expect(appendFactToLedgerMock).toHaveBeenCalledTimes(5);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('ran out of time'));
  });

  it('stops cleanly, keeps what it wrote, and logs the remainder when time runs low', async () => {
    // 10 docs, but the clock reports "under the buffer" from the third check onward. The run must yield
    // rather than throw: the two docs already folded stay in the ledger.
    seedLake(10);
    const logger = makeLogger();
    let call = 0;
    const remaining = () => (++call <= 2 ? 10 * 60_000 : 1_000);

    const result = await extractLakeMemoryForBatch(
      { dataLakeId: 'lake-1', getRemainingTimeInMillis: remaining },
      logger as never
    );

    expect(result.docsProcessed).toBe(2);
    expect(appendFactToLedgerMock).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ran out of time after 2/10 docs'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('8 not yet covered'));
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
