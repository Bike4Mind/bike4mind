/**
 * Consecutive-failure breaker tests for `extractLakeMemoryForBatch`.
 *
 * The per-document catch exists so one bad doc cannot abort a whole lake, and that is right - but on its
 * own it turns a SYSTEMIC failure (the chunk store down, the extractor's provider rejecting every call)
 * into a run that skips every document, records the last one it TOUCHED as the cursor, and chains a
 * continuation. The chain then walks the entire lake writing nothing while marking it covered, and the
 * next full re-scan is the first thing that would notice. These tests pin the breaker: past the
 * threshold the run stops, the cursor stays at the last document that actually completed, and no
 * continuation is chained.
 *
 * Its own file for the same reason the deadline guard has one: the shared harness mocks everything,
 * while extractLakeMemory.test.ts deliberately mocks nothing.
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
const setLakeMemoryCursorIfFenceUnmovedMock = vi.fn();

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: vi.fn().mockResolvedValue(undefined) },
  apiKeyRepository: {},
  dataLakeRepository: {
    findById: (...a: unknown[]) => findByIdMock(...a),
    claimLakeMemoryExtraction: (...a: unknown[]) => claimLakeMemoryExtractionMock(...a),
    releaseLakeMemoryExtraction: (...a: unknown[]) => releaseLakeMemoryExtractionMock(...a),
    setLakeMemoryCursor: (...a: unknown[]) => setLakeMemoryCursorMock(...a),
    setLakeMemoryCursorIfFenceUnmoved: (...a: unknown[]) => setLakeMemoryCursorIfFenceUnmovedMock(...a),
    getLakeMemoryFence: async () => ({ exists: true, purgedAt: null }),
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

const docId = (i: number) => `doc-${String(i).padStart(3, '0')}`;

/** Paged member read over an in-memory id list, honoring `after` and `limit` as the repository does. */
const seedLake = (docCount: number) => {
  findByIdMock.mockResolvedValue({ id: 'lake-1', createdByUserId: 'owner-1', datalakeTag: 'datalake:test' });
  const ids = Array.from({ length: docCount }, (_, i) => docId(i));
  findLakeMemoryExtractionMembersMock.mockImplementation(
    async (_scope: unknown, { after, limit }: { after?: string | null; limit: number }) =>
      [...ids]
        .sort()
        .filter(id => !after || id > after)
        .slice(0, limit)
        .map(id => ({ fabFileId: id, fileName: `${id}.md`, tags: [] }))
  );
  evaluateMock.mockResolvedValue([{ fact: 'the X-200 ships with 36 units' }]);
};

/**
 * Inject per-document outcomes at the chunk read, which is the first thing inside the loop's try. A
 * `throw` stands in for any systemic dependency failure; `''` is the legitimately-empty document.
 */
const seedChunks = (outcome: (id: string) => string | 'throw') => {
  findTextsByFabFileIdMock.mockImplementation(async (id: string) => {
    const text = outcome(id);
    if (text === 'throw') throw new Error(`chunk store unavailable for ${id}`);
    return [{ text }];
  });
};

const READABLE = 'some durable reference text';

describe('extractLakeMemoryForBatch consecutive-failure breaker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimLakeMemoryExtractionMock.mockResolvedValue(true);
    releaseLakeMemoryExtractionMock.mockResolvedValue(undefined);
    setLakeMemoryCursorMock.mockResolvedValue(undefined);
    setLakeMemoryCursorIfFenceUnmovedMock.mockResolvedValue(true);
    appendMock.mockResolvedValue(true);
  });

  it('aborts on a failure storm, leaving the cursor at the last doc that COMPLETED and chaining nothing', async () => {
    // Two docs fold, then the dependency goes down for the rest of the lake.
    seedLake(20);
    seedChunks(id => (id === docId(0) || id === docId(1) ? READABLE : 'throw'));
    const logger = makeLogger();

    const result = await extractLakeMemoryForBatch(
      { dataLakeId: 'lake-1', getRemainingTimeInMillis: () => 10 * 60_000 },
      logger as never
    );

    // Five back-to-back failures (docs 2..6) trip the breaker, so the loop stops there rather than
    // skipping all 18 remaining docs. Attempts are counted at the chunk read - the first thing inside
    // the loop's try - since the return shape reports only what was processed.
    expect(findTextsByFabFileIdMock).toHaveBeenCalledTimes(7);
    expect(result.docsProcessed).toBe(2);

    // The cursor is the last COMPLETED doc, not the last ATTEMPTED one. Recording doc-006 would claim
    // the failing tail as covered and is exactly the defect the breaker exists to prevent.
    expect(setLakeMemoryCursorIfFenceUnmovedMock).toHaveBeenCalledTimes(1);
    expect(setLakeMemoryCursorIfFenceUnmovedMock.mock.calls[0][1]).toBe(docId(1));

    // No continuation: re-enqueuing would re-enter the same dead dependency immediately. The next
    // batch finalize is the retry trigger.
    expect(result.hasMore).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('failed back-to-back'));
    // The run yields rather than throwing, so SQS does not redeliver and re-bill the folded prefix.
    expect(releaseLakeMemoryExtractionMock).toHaveBeenCalledTimes(1);
  });

  it('writes no cursor at all when the storm starts before the first doc completes', async () => {
    seedLake(20);
    seedChunks(() => 'throw');
    const logger = makeLogger();

    const result = await extractLakeMemoryForBatch(
      { dataLakeId: 'lake-1', getRemainingTimeInMillis: () => 10 * 60_000 },
      logger as never
    );

    expect(findTextsByFabFileIdMock).toHaveBeenCalledTimes(5);
    expect(result.docsProcessed).toBe(0);
    // Nothing was covered, so there is no ground to claim - and the previous cursor must be left
    // exactly where it was rather than advanced or cleared.
    expect(setLakeMemoryCursorIfFenceUnmovedMock).not.toHaveBeenCalled();
    expect(setLakeMemoryCursorMock).not.toHaveBeenCalled();
    expect(result.hasMore).toBe(false);
  });

  it('does not abort on scattered bad documents, however many: the streak is what matters', async () => {
    // 8 failing docs out of 20, but never five in a row. This is the pre-existing "one bad doc" case
    // and the breaker must stay out of its way, or a lake with a few unparseable files would stop
    // folding entirely.
    seedLake(20);
    seedChunks(id => (Number(id.slice(-3)) % 2 === 1 ? 'throw' : READABLE));
    const logger = makeLogger();

    const result = await extractLakeMemoryForBatch(
      { dataLakeId: 'lake-1', getRemainingTimeInMillis: () => 10 * 60_000 },
      logger as never
    );

    expect(findTextsByFabFileIdMock).toHaveBeenCalledTimes(20);
    expect(result.docsProcessed).toBe(10);
    expect(logger.error).not.toHaveBeenCalled();
    // Whole slice covered, nothing beyond it: no continuation cursor is written.
    expect(setLakeMemoryCursorIfFenceUnmovedMock).not.toHaveBeenCalled();
    expect(result.hasMore).toBe(false);
  });

  it('lets a legitimately empty document reset the streak', async () => {
    // Four failures, one empty doc, four more failures. Eight failures, no five consecutive - and the
    // empty doc is COVERED, not skipped, so it must clear the streak like a completed one. Without
    // that reset a lake with empty files interleaved would trip the breaker on a non-systemic fault.
    seedLake(12);
    seedChunks(id => {
      const i = Number(id.slice(-3));
      if (i === 4) return '   ';
      return i < 9 ? 'throw' : READABLE;
    });
    const logger = makeLogger();

    const result = await extractLakeMemoryForBatch(
      { dataLakeId: 'lake-1', getRemainingTimeInMillis: () => 10 * 60_000 },
      logger as never
    );

    expect(findTextsByFabFileIdMock).toHaveBeenCalledTimes(12);
    expect(logger.error).not.toHaveBeenCalled();
    expect(result.hasMore).toBe(false);
  });
});
