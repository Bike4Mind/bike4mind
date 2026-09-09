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
const setLakeMemoryCursorIfFenceUnmovedMock = vi.fn();
const getLakeMemoryFenceMock = vi.fn();
const sessionParamsMock = vi.fn();

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: vi.fn().mockResolvedValue(undefined) },
  apiKeyRepository: {},
  dataLakeRepository: {
    findById: (...a: unknown[]) => findByIdMock(...a),
    claimLakeMemoryExtraction: (...a: unknown[]) => claimLakeMemoryExtractionMock(...a),
    releaseLakeMemoryExtraction: (...a: unknown[]) => releaseLakeMemoryExtractionMock(...a),
    setLakeMemoryCursor: (...a: unknown[]) => setLakeMemoryCursorMock(...a),
    setLakeMemoryCursorIfFenceUnmoved: (...a: unknown[]) => setLakeMemoryCursorIfFenceUnmovedMock(...a),
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
  createLedgerAppendSession: async (...a: unknown[]) => {
    sessionParamsMock(...a);
    return { append: (...b: unknown[]) => appendMock(...b) };
  },
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

/**
 * A purge that lands AFTER the run claimed its lease - the only kind the fence refuses. Evaluated when
 * the mock is called, so it necessarily post-dates the run's `claimedAt`. A hardcoded past timestamp
 * would describe a purge that PREDATES the run, which the fence deliberately lets through so a rebuild
 * can re-key a lake that was erased once already.
 */
const purgedNow = () => new Date();

describe('extractLakeMemoryForBatch purge fence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimLakeMemoryExtractionMock.mockResolvedValue(true);
    releaseLakeMemoryExtractionMock.mockResolvedValue(undefined);
    // The ledger seals by default; a test that wants a refusal says so. Left undefined this would read
    // as a refusal on the first fact and silently stop every run in this file.
    appendMock.mockResolvedValue(true);
    setLakeMemoryCursorMock.mockResolvedValue(undefined);
    setLakeMemoryCursorIfFenceUnmovedMock.mockResolvedValue(true);
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
      purgedAt: ++checks >= 3 ? purgedNow() : null,
    }));

    const result = await extractLakeMemoryForBatch(PLENTY_OF_TIME, logger as never);

    expect(appendMock).toHaveBeenCalledTimes(2);
    expect(result.hasMore).toBe(false);
    expect(setLakeMemoryCursorMock).not.toHaveBeenCalled();
    expect(setLakeMemoryCursorIfFenceUnmovedMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('purged (or the lake deleted) after 2/10'));
  });

  it('does not ask for a continuation run, so the chain ends with the purge', async () => {
    // hasMore drives the handler's re-enqueue. A purged lake that still asked for a continuation would
    // keep billing LLM work to rebuild exactly what was just erased.
    seedLake(10);
    getLakeMemoryFenceMock.mockResolvedValue({ exists: true, purgedAt: purgedNow() });

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
    expect(setLakeMemoryCursorIfFenceUnmovedMock).not.toHaveBeenCalled();
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
      purgedAt: ++checks > 100 ? purgedNow() : null,
    }));

    const result = await extractLakeMemoryForBatch(PLENTY_OF_TIME, logger as never);

    expect(appendMock).toHaveBeenCalledTimes(100);
    expect(setLakeMemoryCursorMock).not.toHaveBeenCalled();
    expect(setLakeMemoryCursorIfFenceUnmovedMock).not.toHaveBeenCalled();
    expect(result.hasMore).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('as this run finished'));
  });

  it('leaves the cleared cursor alone when the purge lands DURING the cursor write', async () => {
    // The residual window the end-of-run fence READ cannot close: read and write are two round trips,
    // so a purge in between would have its cursor clear reinstated here. The write itself is therefore
    // conditional on the fence, and a lost race must not chain a continuation - the resumed run would
    // otherwise start mid-lake, past documents whose beliefs the purge destroyed, and nothing re-scans
    // from the top until two further runs have walked the cursor off the end.
    seedLake(101);
    const logger = makeLogger();
    // Every fence READ says unmoved; only the guarded WRITE reports the race.
    getLakeMemoryFenceMock.mockResolvedValue({ exists: true, purgedAt: null });
    setLakeMemoryCursorIfFenceUnmovedMock.mockResolvedValue(false);

    const result = await extractLakeMemoryForBatch(PLENTY_OF_TIME, logger as never);

    expect(setLakeMemoryCursorIfFenceUnmovedMock).toHaveBeenCalledWith('lake-1', 'doc-099', null);
    expect(result.hasMore).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('as the continuation cursor was being written'));
  });

  it("compares against the run's own fence snapshot, not a constant", async () => {
    // A lake purged BEFORE this run started carries a non-null fence, and the guard has to compare
    // against that value. Hardcoding null would make the write unconditional for every such lake -
    // i.e. exactly the lakes that have been erased once already.
    seedLake(101, { lakeMemoryPurgedAt: new Date('2026-09-01T00:00:00.000Z') });
    getLakeMemoryFenceMock.mockResolvedValue({ exists: true, purgedAt: new Date('2026-09-01T00:00:00.000Z') });

    await extractLakeMemoryForBatch(PLENTY_OF_TIME, makeLogger() as never);

    expect(setLakeMemoryCursorIfFenceUnmovedMock).toHaveBeenCalledWith(
      'lake-1',
      'doc-099',
      new Date('2026-09-01T00:00:00.000Z')
    );
  });

  it('leaves an ordinary run untouched when the fence never moves', async () => {
    // The regression that matters most: a fence check that aborted healthy runs would silently stop the
    // whole producer, and every other test here would still pass.
    seedLake(5);
    const logger = makeLogger();

    const result = await extractLakeMemoryForBatch(PLENTY_OF_TIME, logger as never);

    expect(result.docsProcessed).toBe(5);
    expect(result.factsWritten).toBe(5);
    expect(result.factsRefused).toBe(0);
    expect(appendMock).toHaveBeenCalledTimes(5);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('purged'));
  });

  it('lets a lake purged BEFORE the run build normally, rather than treating any stamp as a trip', async () => {
    // A lake purged last week starts its next build with a non-null stamp. Treating any stamp as a trip
    // would make that lake permanently unbuildable - the fence asks whether a purge landed AFTER this
    // run claimed its lease, which is the same question the ledger's tombstone fence asks of the key.
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

  it('refuses a purge that lands between the lease claim and the post-claim fence snapshot', async () => {
    // The window that made the fence decorative. The snapshot the run compares against is read AFTER it
    // claims the lease, so a purge landing in between is already baked INTO that snapshot: a change test
    // compares the stamp with itself, never trips, and the run re-extracts the whole lake under the very
    // key the purge destroyed. Both findById reads are staged to reproduce exactly that ordering.
    seedMembers(Array.from({ length: 10 }, (_, i) => `doc-${String(i).padStart(3, '0')}`));
    findTextsByFabFileIdMock.mockResolvedValue([{ text: 'some durable reference text' }]);
    evaluateMock.mockResolvedValue([{ fact: 'the X-200 ships with 36 units' }]);
    const base = { id: 'lake-1', createdByUserId: 'owner-1', datalakeTag: 'datalake:test' };
    let reads = 0;
    let landedAt: Date | null = null;
    findByIdMock.mockImplementation(async () => {
      // First read is pre-claim and sees a clean lake; the post-claim re-read already carries the purge.
      if (++reads === 1) return { ...base };
      landedAt = landedAt ?? purgedNow();
      return { ...base, lakeMemoryPurgedAt: landedAt };
    });
    getLakeMemoryFenceMock.mockImplementation(async () => ({ exists: true, purgedAt: landedAt }));
    const logger = makeLogger();

    const result = await extractLakeMemoryForBatch(PLENTY_OF_TIME, logger as never);

    expect(appendMock).not.toHaveBeenCalled();
    expect(result.factsWritten).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(setLakeMemoryCursorMock).not.toHaveBeenCalled();
    expect(setLakeMemoryCursorIfFenceUnmovedMock).not.toHaveBeenCalled();
  });

  it("opens the ledger session at the LEASE CLAIM, not at the session's own open", async () => {
    // The ledger lifts a tombstone only when the shred strictly predates `startedAt`, so defaulting
    // that to the session open would date the run AFTER a shred landing in the claim-to-open window -
    // and the fence would lift its own tombstone and re-mint a key over an erasure. Pinned to the exact
    // instant handed to the lease claim, which is the earliest moment this run can be said to exist.
    seedLake(2);

    await extractLakeMemoryForBatch(PLENTY_OF_TIME, makeLogger() as never);

    const claimedAt = claimLakeMemoryExtractionMock.mock.calls[0][1] as Date;
    expect(claimedAt).toBeInstanceOf(Date);
    expect(sessionParamsMock).toHaveBeenCalledWith(expect.objectContaining({ startedAt: claimedAt }));
  });

  it('stops the run when the ledger REFUSES a write, and never counts it as written', async () => {
    // The other half of the fence, and useless without it: `append` returns false when the shred fence
    // rejects the seal. Discarding that boolean made every refused fact increment factsWritten, so a run
    // whose key had been destroyed reported a clean success and chained a continuation.
    seedLake(10);
    const logger = makeLogger();
    appendMock.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);

    const result = await extractLakeMemoryForBatch(PLENTY_OF_TIME, logger as never);

    expect(result.factsWritten).toBe(2);
    expect(result.factsRefused).toBe(1);
    // Stopped on the refusal rather than grinding through the remaining eight documents.
    expect(appendMock).toHaveBeenCalledTimes(3);
    expect(result.hasMore).toBe(false);
    expect(setLakeMemoryCursorMock).not.toHaveBeenCalled();
    expect(setLakeMemoryCursorIfFenceUnmovedMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('the ledger refused a write'));
  });

  it('releases the extraction lease when it stops on the fence', async () => {
    // The lease is deliberately NOT cleared by the purge itself, precisely so this run releases it -
    // otherwise a post-purge rebuild would 409 until the lease aged out.
    seedLake(10);
    getLakeMemoryFenceMock.mockResolvedValue({ exists: true, purgedAt: purgedNow() });

    await extractLakeMemoryForBatch(PLENTY_OF_TIME, makeLogger() as never);

    expect(releaseLakeMemoryExtractionMock).toHaveBeenCalledTimes(1);
  });
});
