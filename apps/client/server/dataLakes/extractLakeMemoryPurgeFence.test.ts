/**
 * Purge-fence tests for `extractLakeMemoryForBatch`.
 *
 * An erase has to survive a build that is already running. Without the fence, a purge crypto-shreds the
 * profile and the in-flight run simply carries on: it appends the remaining documents' facts under a
 * fresh key, so facts the user erased come back, and its end-of-slice bookkeeping rewrites the very
 * cursor the purge cleared - leaving the next build to resume mid-lake and skip everything the purged
 * scan had already passed.
 *
 * Own file, like the deadline guard's: extractLakeMemory.test.ts covers the pure `evidenceTierForDoc`
 * and deliberately mocks nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findByIdMock = vi.fn();
const findLakeMemoryExtractionMembersMock = vi.fn();
const findTextsByFabFileIdMock = vi.fn();
const evaluateMock = vi.fn();
const appendMock = vi.fn();
const claimLakeMemoryExtractionMock = vi.fn();
const releaseLakeMemoryExtractionMock = vi.fn();
const setLakeMemoryCursorMock = vi.fn();
const getLakeMemoryFenceMock = vi.fn();

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: vi.fn().mockResolvedValue(undefined) },
  apiKeyRepository: {},
  dataLakeRepository: {
    findById: (...a: unknown[]) => findByIdMock(...a),
    claimLakeMemoryExtraction: (...a: unknown[]) => claimLakeMemoryExtractionMock(...a),
    releaseLakeMemoryExtraction: (...a: unknown[]) => releaseLakeMemoryExtractionMock(...a),
    setLakeMemoryCursor: (...a: unknown[]) => setLakeMemoryCursorMock(...a),
    getLakeMemoryFence: (...a: unknown[]) => getLakeMemoryFenceMock(...a),
  },
  fabFileChunkRepository: { findTextsByFabFileId: (...a: unknown[]) => findTextsByFabFileIdMock(...a) },
  fabFileRepository: {
    findLakeMemoryExtractionMembers: (...a: unknown[]) => findLakeMemoryExtractionMembersMock(...a),
  },
}));
vi.mock('@bike4mind/common', () => ({
  MEMENTO_EMBEDDING_MODEL: 'text-embedding-3-small',
  toMementoVector: (v: number[]) => v,
  LAKE_MEMORY_EXTRACTION_LEASE_MS: 15 * 60_000,
}));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) },
  dataLakeService: { lakeMembershipScope: () => 'datalake:test' },
  LakeMemoryExtractionService: class {
    evaluate = (...a: unknown[]) => evaluateMock(...a);
  },
}));
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

/** Honors the keyset `after` and `limit` for real, so the probe row and resume point behave. */
const seedMembers = (ids: string[]) => {
  findLakeMemoryExtractionMembersMock.mockImplementation(
    async (_scope: unknown, { after, limit }: { after?: string | null; limit: number }) =>
      [...ids]
        .sort()
        .filter(id => !after || id > after)
        .slice(0, limit)
        .map(id => ({ fabFileId: id, fileName: `${id}.md`, tags: [] }))
  );
};

/** N live docs, each with readable text and one extractable fact. */
const seedLake = (docCount: number, lakeOver: Record<string, unknown> = {}) => {
  findByIdMock.mockResolvedValue({
    id: 'lake-1',
    createdByUserId: 'owner-1',
    datalakeTag: 'datalake:test',
    ...lakeOver,
  });
  seedMembers(Array.from({ length: docCount }, (_, i) => `doc-${String(i).padStart(3, '0')}`));
  findTextsByFabFileIdMock.mockResolvedValue([{ text: 'some durable reference text' }]);
  evaluateMock.mockResolvedValue([{ fact: 'the X-200 ships with 36 units' }]);
};

const PLENTY_OF_TIME = { dataLakeId: 'lake-1', getRemainingTimeInMillis: () => 10 * 60_000 };

describe('extractLakeMemoryForBatch purge fence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimLakeMemoryExtractionMock.mockResolvedValue(true);
    releaseLakeMemoryExtractionMock.mockResolvedValue(undefined);
    setLakeMemoryCursorMock.mockResolvedValue(undefined);
    getLakeMemoryFenceMock.mockResolvedValue({ exists: true, purgedAt: null });
  });

  it('stops mid-run when a purge lands, and records no continuation cursor', async () => {
    // 10 docs; the fence moves on the third check, so two docs fold and the rest do not. The cursor is
    // the assertion that matters: writing one here would send the next build past documents whose facts
    // the purge just destroyed.
    seedLake(10);
    const logger = makeLogger();
    let checks = 0;
    getLakeMemoryFenceMock.mockImplementation(async () => ({
      exists: true,
      purgedAt: ++checks >= 3 ? new Date('2026-09-06T12:00:00.000Z') : null,
    }));

    const result = await extractLakeMemoryForBatch(PLENTY_OF_TIME, logger as never);

    expect(appendMock).toHaveBeenCalledTimes(2);
    expect(result.hasMore).toBe(false);
    expect(setLakeMemoryCursorMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('purged (or the lake deleted) after 2/10'));
  });

  it('does not ask for a continuation run, so the chain ends with the purge', async () => {
    // hasMore drives the handler's re-enqueue. A purged lake that still asked for a continuation would
    // keep billing LLM work to rebuild exactly what was just erased.
    seedLake(10);
    getLakeMemoryFenceMock.mockResolvedValue({ exists: true, purgedAt: new Date('2026-09-06T12:00:00.000Z') });

    const result = await extractLakeMemoryForBatch(PLENTY_OF_TIME, makeLogger() as never);

    expect(result).toEqual(expect.objectContaining({ docsProcessed: 0, factsWritten: 0, hasMore: false }));
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('stops when the lake document disappears mid-run', async () => {
    // The deletion sweep crypto-shreds the profile and then deletes the record, so a vanished document
    // is the same signal as a purge: keep appending and a deleted lake is left with a readable ledger.
    seedLake(10);
    let checks = 0;
    getLakeMemoryFenceMock.mockImplementation(async () => ({ exists: ++checks < 3, purgedAt: null }));

    const result = await extractLakeMemoryForBatch(PLENTY_OF_TIME, makeLogger() as never);

    expect(appendMock).toHaveBeenCalledTimes(2);
    expect(result.hasMore).toBe(false);
    expect(setLakeMemoryCursorMock).not.toHaveBeenCalled();
  });

  it('suppresses the cursor write when the purge lands after the last document', async () => {
    // The window the per-document checks cannot see: the loop is done, and the cursor write is still
    // ahead. 101 docs so the slice fills and the probe row reports more beyond it - the one path that
    // WRITES a cursor. The fence moves only on the final check (100 in-loop, then one more).
    seedLake(101);
    const logger = makeLogger();
    let checks = 0;
    getLakeMemoryFenceMock.mockImplementation(async () => ({
      exists: true,
      purgedAt: ++checks > 100 ? new Date('2026-09-06T12:00:00.000Z') : null,
    }));

    const result = await extractLakeMemoryForBatch(PLENTY_OF_TIME, logger as never);

    expect(appendMock).toHaveBeenCalledTimes(100);
    expect(setLakeMemoryCursorMock).not.toHaveBeenCalled();
    expect(result.hasMore).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('as this run finished'));
  });

  it('leaves an ordinary run untouched when the fence never moves', async () => {
    // The regression that matters most: a fence check that aborted healthy runs would silently stop the
    // whole producer, and every other test here would still pass.
    seedLake(5);
    const logger = makeLogger();

    const result = await extractLakeMemoryForBatch(PLENTY_OF_TIME, logger as never);

    expect(result.docsProcessed).toBe(5);
    expect(appendMock).toHaveBeenCalledTimes(5);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('purged'));
  });

  it('compares against the run\'s own snapshot, not "has this lake ever been purged"', async () => {
    // A lake purged last week starts its next build with a non-null stamp. Treating any stamp as a trip
    // would make that lake permanently unbuildable - the fence is about CHANGE since the run claimed it.
    const purgedLastWeek = new Date('2026-08-30T00:00:00.000Z');
    seedLake(5, { lakeMemoryPurgedAt: purgedLastWeek });
    getLakeMemoryFenceMock.mockResolvedValue({ exists: true, purgedAt: purgedLastWeek });

    const result = await extractLakeMemoryForBatch(PLENTY_OF_TIME, makeLogger() as never);

    expect(result.docsProcessed).toBe(5);
    expect(appendMock).toHaveBeenCalledTimes(5);
  });

  it('treats a failed fence read as unmoved rather than aborting the run', async () => {
    // Fail-open on purpose: a transient DB blip must not kill a legitimate, LLM-billed extraction, and
    // the next document re-reads the fence anyway.
    seedLake(4);
    getLakeMemoryFenceMock.mockRejectedValue(new Error('mongo down'));

    const result = await extractLakeMemoryForBatch(PLENTY_OF_TIME, makeLogger() as never);

    expect(result.docsProcessed).toBe(4);
    expect(appendMock).toHaveBeenCalledTimes(4);
  });

  it('releases the extraction lease when it stops on the fence', async () => {
    // The lease is deliberately NOT cleared by the purge itself, precisely so this run releases it -
    // otherwise a post-purge rebuild would 409 until the lease aged out.
    seedLake(10);
    getLakeMemoryFenceMock.mockResolvedValue({ exists: true, purgedAt: new Date('2026-09-06T12:00:00.000Z') });

    await extractLakeMemoryForBatch(PLENTY_OF_TIME, makeLogger() as never);

    expect(releaseLakeMemoryExtractionMock).toHaveBeenCalledTimes(1);
  });
});
