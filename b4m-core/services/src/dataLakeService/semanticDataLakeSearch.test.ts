import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Cosine is a hoisted mock so individual tests can vary scores; the default keeps every chunk
// above the floor, which is what the pre-existing exclusion/scoping tests assume.
// mockCreateEmbeddingService is a spy (not just a stub) so multi-model tests can assert exactly
// which models were embedded and how many times.
const { mockCosine, mockCreateEmbeddingService, mockGenerateEmbedding } = vi.hoisted(() => ({
  mockCosine: vi.fn(() => 0.9),
  mockCreateEmbeddingService: vi.fn(),
  // Defaulted in beforeEach to the model-encoding vector every other test assumes; overridable so
  // the empty-embedding return path can be exercised.
  mockGenerateEmbedding: vi.fn(),
}));

// Mock only the embedding/provider helpers from the utils barrel; keep the real
// `@bike4mind/utils/retrievalExclusion` subpath so filterRetrievalExcluded runs for real.
//
// getProviderFromModel branches on a 'voyage-' prefix (not a hardcoded 'openai') and
// createEmbeddingService returns a vector that ENCODES the model, so a mixed-model test can prove
// each ANN call embedded the query under its OWN model rather than reusing the primary embed.
// This does not affect scoring: computeCosineSimilarity is mocked separately below and the ANN
// path never calls it (adapter mocks supply raw hit scores directly).
vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    getProviderFromModel: (m: string) => (m.startsWith('voyage-') ? 'voyageai' : 'openai'),
    computeCosineSimilarity: mockCosine,
    EmbeddingFactory: class {
      createEmbeddingService(model: string) {
        mockCreateEmbeddingService(model);
        return { generateEmbedding: async () => mockGenerateEmbedding(model) };
      }
    },
  };
});

import {
  comparedNoPassages,
  fileScopedSemanticSearch,
  semanticDataLakeSearch,
  type SemanticDataLakeSearchParams,
} from './semanticDataLakeSearch';
import { describeSearchLimitations, isPartialSearch } from './retrievalUnavailable';

beforeEach(() => {
  mockCosine.mockReset();
  mockCosine.mockReturnValue(0.9);
  mockCreateEmbeddingService.mockClear();
  mockGenerateEmbedding.mockReset();
  mockGenerateEmbedding.mockImplementation((model: string) => [model.length, 0]);
});

const baseParams = (): SemanticDataLakeSearchParams => ({
  userId: 'u1',
  query: 'stage III treatment',
  embeddingModel: 'text-embedding-ada-002' as SemanticDataLakeSearchParams['embeddingModel'],
  apiKeyTable: { openai: 'k' },
  dataLakeTags: ['datalake:x'],
  dataLakeTagPrefixes: [],
});

const makeAdapters = (findVectors: ReturnType<typeof vi.fn>) => ({
  db: {
    fabfiles: {
      search: vi.fn().mockResolvedValue({
        data: [
          { id: 'm', fileName: 'MARK - retired.pdf', tags: [], vectorized: true },
          { id: 'c', fileName: 'Clean.pdf', tags: [], vectorized: true },
        ],
        hasMore: false,
        total: 2,
      }),
    },
    fabfilechunks: { findVectorsByFabFileIds: findVectors },
  },
});

describe('semanticDataLakeSearch retrieval exclusion', () => {
  it('drops an excluded file BEFORE loading its chunk vectors', async () => {
    const findVectors = vi.fn().mockResolvedValue([]);
    await semanticDataLakeSearch(
      { ...baseParams(), retrievalFilter: { excludeFilenameMarkers: ['MARK'] } },
      makeAdapters(findVectors) as never
    );
    // The vector lookup must be scoped to the clean file only - the marked file never
    // reaches the (expensive) vector load.
    expect(findVectors).toHaveBeenCalledTimes(1);
    expect(findVectors.mock.calls[0][0]).toEqual(['c']);
  });

  it('no filter (default): both files are scoped for vector lookup', async () => {
    const findVectors = vi.fn().mockResolvedValue([]);
    await semanticDataLakeSearch(baseParams(), makeAdapters(findVectors) as never);
    expect(findVectors.mock.calls[0][0]).toEqual(['m', 'c']);
  });

  /**
   * The bail above is an optimization for a caller who HAS no lake. A caller whose lakes were
   * suppressed deliberately still has a corpus - their own and shared files, which collectScopedFiles
   * admits via includeShared - and bailing there drops the turn to metadata-only keyword search.
   *
   * Exercises the real function rather than a mock of it on purpose: the tool-level test asserts the
   * CALL shape (dataLakeTags: []), which passes whether or not this bail fires, so a fix that never
   * ran read as verified for a whole round.
   */
  it("ownFilesOnly: with no lake tags it still scopes the caller's own files instead of bailing", async () => {
    const findVectors = vi.fn().mockResolvedValue([]);
    const adapters = makeAdapters(findVectors);
    await semanticDataLakeSearch({ ...baseParams(), dataLakeTags: [], ownFilesOnly: true }, adapters as never);
    // The DB is consulted - the thing the default path skips.
    expect(adapters.db.fabfiles.search).toHaveBeenCalled();
    const opts = (adapters.db.fabfiles.search as ReturnType<typeof vi.fn>).mock.calls[0][5];
    // ...over own + shared files, with no lake arms.
    expect(opts.includeShared).toBe(true);
    expect(opts.dataLakeTags).toEqual([]);
  });

  it('tag path unchanged after core extraction: no data-lake tags returns empty without touching the DB', async () => {
    const findVectors = vi.fn().mockResolvedValue([]);
    const adapters = makeAdapters(findVectors);
    const result = await semanticDataLakeSearch({ ...baseParams(), dataLakeTags: [] }, adapters as never);
    expect(result.results).toEqual([]);
    expect(adapters.db.fabfiles.search).not.toHaveBeenCalled();
    expect(findVectors).not.toHaveBeenCalled();
    // A short-circuit still reports a well-formed (complete, empty) scan.
    expect(result.scan.truncated).toBe(false);
    expect(result.scan.chunksScanned).toBe(0);
  });
});

/** Chunk rows for a paging mock: `n` chunks belonging to `fileId`, ids ascending. */
const chunkRows = (fileId: string, n: number, startIndex = 0) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${fileId}-c${String(startIndex + i).padStart(4, '0')}`,
    fabFileId: fileId,
    text: `text ${startIndex + i}`,
    vector: [1, 0],
  }));

/**
 * Keyset-paging mock that behaves like the real repository: filters to the requested ids, honours
 * `afterChunkId`, sorts by id, and applies `limit`. Tests that assert budget/probe behaviour are
 * only meaningful against a mock that actually pages.
 */
const pagingChunkMock = (allRows: { id: string; fabFileId: string; text: string; vector: number[] }[]) =>
  vi.fn((ids: string[], opts?: { limit?: number; afterChunkId?: string }) => {
    const limit = opts?.limit ?? 10_000;
    const rows = allRows
      .filter(r => ids.includes(r.fabFileId))
      .filter(r => (opts?.afterChunkId ? r.id > opts.afterChunkId : true))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit);
    return Promise.resolve(rows);
  });

const filesAdapter = (
  pages: { data: { id: string; fileName: string; tags?: unknown[] }[]; hasMore: boolean; total: number }[]
) => {
  const search = vi.fn((..._args: unknown[]) => {
    const page = (_args[3] as { page: number }).page;
    return Promise.resolve(pages[page - 1] ?? { data: [], hasMore: false, total: pages[0]?.total ?? 0 });
  });
  return search;
};

/**
 * A files adapter that serves from ONE corpus using the real skip/limit contract
 * (`skip = (page - 1) * limit`, as buildFabFileSearchQuery computes it) instead of returning
 * canned pages keyed on page number. Page-keyed mocks cannot see a wrong offset, which is exactly
 * how a shrinking page limit shipped a walk that re-read rows and never reached the tail.
 */
const skipAwareFilesAdapter = (corpus: { id: string; fileName: string; tags?: unknown[] }[]) =>
  vi.fn((..._args: unknown[]) => {
    const { page, limit } = _args[3] as { page: number; limit: number };
    const skip = (page - 1) * limit;
    const slice = corpus.slice(skip, skip + limit);
    return Promise.resolve({ data: slice, hasMore: skip + limit < corpus.length, total: corpus.length });
  });

const makeLogger = () => ({ warn: vi.fn(), debug: vi.fn(), error: vi.fn(), log: vi.fn() });

// #2243: retrieval resolves a dynamic lake's prefix arm through `lakeMemberships`, replacing the
// caller-anchored `scopedTagPrefixes` this module used to forward. Net-new coverage - this module
// never pinned `scopedTagPrefixes` reaching fabfiles.search at all.
describe('semanticDataLakeSearch lakeMemberships (#2243)', () => {
  const MEMBERSHIP = { datalakeTag: 'datalake:x', fileTagPrefix: 'x:', creatorUserId: 'creator-1' };

  it('reaches fabfiles.search on EVERY page of the paging walk', async () => {
    const pageOne = Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, fileName: `F${i}.pdf`, tags: [] }));
    const pageTwo = [{ id: 'g0', fileName: 'G0.pdf', tags: [] }];
    const search = filesAdapter([
      { data: pageOne, hasMore: true, total: 11 },
      { data: pageTwo, hasMore: false, total: 11 },
    ]);

    await semanticDataLakeSearch({ ...baseParams(), lakeMemberships: [MEMBERSHIP], budgets: { filePageSize: 10 } }, {
      db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds: pagingChunkMock([]) } },
    } as never);

    expect(search).toHaveBeenCalledTimes(2);
    for (const call of search.mock.calls) {
      expect((call[5] as { lakeMemberships?: unknown[] }).lakeMemberships).toEqual([MEMBERSHIP]);
    }
  });

  it('scopedTagPrefixes is absent from the options object', async () => {
    const search = filesAdapter([{ data: [], hasMore: false, total: 0 }]);
    await semanticDataLakeSearch({ ...baseParams(), lakeMemberships: [MEMBERSHIP] }, {
      db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds: pagingChunkMock([]) } },
    } as never);
    expect(search.mock.calls[0][5]).not.toHaveProperty('scopedTagPrefixes');
  });

  it('ownFilesOnly with no lake tags still sends lakeMemberships: [] + includeShared: true', async () => {
    const search = filesAdapter([{ data: [], hasMore: false, total: 0 }]);
    await semanticDataLakeSearch({ ...baseParams(), dataLakeTags: [], ownFilesOnly: true }, {
      db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds: pagingChunkMock([]) } },
    } as never);
    const opts = search.mock.calls[0][5] as { lakeMemberships?: unknown[]; includeShared?: boolean };
    expect(opts.lakeMemberships).toEqual([]);
    expect(opts.includeShared).toBe(true);
  });

  it('the empty-dataLakeTags bail still fires even with non-empty lakeMemberships', async () => {
    const search = filesAdapter([{ data: [], hasMore: false, total: 0 }]);
    const result = await semanticDataLakeSearch({ ...baseParams(), dataLakeTags: [], lakeMemberships: [MEMBERSHIP] }, {
      db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds: pagingChunkMock([]) } },
    } as never);
    expect(search).not.toHaveBeenCalled();
    expect(result.results).toEqual([]);
  });
});

describe('semanticDataLakeSearch bounded scan + honest accounting', () => {
  const oneFile = [{ id: 'f1', fileName: 'F1.pdf', tags: [] }];

  it('a lake that fits stays on the pre-existing single-query path and reports a complete scan', async () => {
    const search = filesAdapter([{ data: oneFile, hasMore: false, total: 1 }]);
    const findVectors = pagingChunkMock(chunkRows('f1', 3));
    const logger = makeLogger();

    const result = await semanticDataLakeSearch({ ...baseParams(), logger: logger as never }, {
      db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds: findVectors } },
    } as never);

    expect(search).toHaveBeenCalledTimes(1);
    expect(findVectors).toHaveBeenCalledTimes(1);
    expect(result.scan.truncated).toBe(false);
    expect(result.scan.chunksScanned).toBe(3);
    expect(result.scan.filesMatching).toBe(1);
  });

  it('a complete scan emits NO warning - an alert that fires on healthy lakes is worthless', async () => {
    const logger = makeLogger();
    await semanticDataLakeSearch({ ...baseParams(), logger: logger as never }, {
      db: {
        fabfiles: { search: filesAdapter([{ data: oneFile, hasMore: false, total: 1 }]) },
        fabfilechunks: { findVectorsByFabFileIds: pagingChunkMock(chunkRows('f1', 3)) },
      },
    } as never);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('pages the file scope past one page instead of silently dropping the tail', async () => {
    // The shape that motivated this: a lake bigger than the old single 2000-file page.
    const pageOne = Array.from({ length: 2000 }, (_, i) => ({ id: `f${i}`, fileName: `F${i}.pdf`, tags: [] }));
    const pageTwo = Array.from({ length: 314 }, (_, i) => ({ id: `g${i}`, fileName: `G${i}.pdf`, tags: [] }));
    const search = filesAdapter([
      { data: pageOne, hasMore: true, total: 2314 },
      { data: pageTwo, hasMore: false, total: 2314 },
    ]);

    const result = await semanticDataLakeSearch({ ...baseParams(), budgets: { filePageSize: 2000 } }, {
      db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds: pagingChunkMock([]) } },
    } as never);

    expect(search).toHaveBeenCalledTimes(2);
    expect((search.mock.calls[1][3] as { page: number }).page).toBe(2);
    expect(result.scan.filesScoped).toBe(2314);
    expect(result.scan.filesMatching).toBe(2314);
    expect(result.scan.truncated).toBe(false);
  });

  it('keeps the page size constant when the budget is not a multiple of it', async () => {
    // The query builder derives skip as (page - 1) * limit, so shrinking the limit to fit the
    // remaining budget silently moves the offset: page 2 would re-read rows it already had and
    // never reach the tail. Only reachable once an operator sets an odd budget, which the new
    // admin setting allows, and invisible on the defaults because 20000 is a multiple of 2000.
    const pageOne = Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, fileName: `F${i}.pdf`, tags: [] }));
    const pageTwo = Array.from({ length: 10 }, (_, i) => ({ id: `g${i}`, fileName: `G${i}.pdf`, tags: [] }));
    const search = filesAdapter([
      { data: pageOne, hasMore: true, total: 20 },
      { data: pageTwo, hasMore: false, total: 20 },
    ]);

    const result = await semanticDataLakeSearch({ ...baseParams(), budgets: { maxFiles: 15, filePageSize: 10 } }, {
      db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds: pagingChunkMock([]) } },
    } as never);

    // Every page asks for the same limit; only `page` advances.
    const limits = search.mock.calls.map(c => (c[3] as { limit: number }).limit);
    expect(limits).toEqual([10, 10]);
    // Trimmed to the budget, with no file counted twice.
    expect(result.scan.filesScoped).toBe(15);
    expect(result.scan.fileBudgetHit).toBe(true);
    expect(result.scan.truncated).toBe(true);
  });

  it('walks a real skip/limit corpus with no file repeated and none missed', async () => {
    // Served through the actual skip arithmetic, so a wrong offset shows up as a duplicate or a
    // gap rather than passing unnoticed the way a page-keyed mock allows.
    const corpus = Array.from({ length: 23 }, (_, i) => ({
      id: `f${String(i).padStart(3, '0')}`,
      fileName: `F${String(i).padStart(3, '0')}.pdf`,
      tags: [],
    }));
    const search = skipAwareFilesAdapter(corpus);
    const seenIds: string[] = [];
    const findVectors = vi.fn((ids: string[]) => {
      seenIds.push(...ids);
      return Promise.resolve([]);
    });

    const result = await semanticDataLakeSearch(
      { ...baseParams(), budgets: { maxFiles: 23, filePageSize: 10, fileGroupSize: 100 } },
      { db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds: findVectors } } } as never
    );

    expect(seenIds).toEqual(corpus.map(f => f.id));
    expect(new Set(seenIds).size).toBe(23);
    expect(result.scan.filesScoped).toBe(23);
    expect(result.scan.filesMatching).toBe(23);
    expect(result.scan.truncated).toBe(false);
  });

  it('a small budget shrinks the query itself, not just the result', async () => {
    // Otherwise lowering the setting to cut latency still sorts and fetches a full page.
    const corpus = Array.from({ length: 500 }, (_, i) => ({ id: `f${i}`, fileName: `F${i}.pdf`, tags: [] }));
    const search = skipAwareFilesAdapter(corpus);

    await semanticDataLakeSearch({ ...baseParams(), budgets: { maxFiles: 25, filePageSize: 2000 } }, {
      db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds: pagingChunkMock([]) } },
    } as never);

    expect((search.mock.calls[0][3] as { limit: number }).limit).toBe(25);
  });

  it('calls search as a method, so a repository whose search uses `this` still works', async () => {
    // The real FabFileRepository.search delegates to this.executeSearch. Passing the method as a
    // bare reference unbinds `this` and throws at runtime - and every vi.fn() mock in this file
    // would still pass, because a plain function has no `this` to lose.
    class RepoLikeTheRealOne {
      private pageSize = 10;
      async executeSearch(page: number) {
        return { data: page === 1 ? [{ id: 'f1', fileName: 'F1.pdf', tags: [] }] : [], hasMore: false, total: 1 };
      }
      async search(..._args: unknown[]) {
        const { page } = _args[3] as { page: number };
        // Reading an instance field as well, so a lost binding cannot silently succeed.
        void this.pageSize;
        return this.executeSearch(page);
      }
    }

    const result = await semanticDataLakeSearch(baseParams(), {
      db: {
        fabfiles: new RepoLikeTheRealOne(),
        fabfilechunks: { findVectorsByFabFileIds: pagingChunkMock(chunkRows('f1', 2)) },
      },
    } as never);

    expect(result.scan.filesScoped).toBe(1);
    expect(result.scan.chunksScanned).toBe(2);
  });

  it('a zero or negative budget cannot make the page ceiling Infinite', async () => {
    // `??` only replaces null/undefined, so an explicit 0 would reach Math.ceil(maxChunks / 0)
    // and produce Infinity for the loop bound. Clamped, this walks and terminates normally.
    const result = await semanticDataLakeSearch(
      { ...baseParams(), budgets: { chunkPageSize: 0, fileGroupSize: 0, filePageSize: 0, maxChunks: -5 } },
      {
        db: {
          fabfiles: { search: filesAdapter([{ data: oneFile, hasMore: false, total: 1 }]) },
          fabfilechunks: { findVectorsByFabFileIds: pagingChunkMock(chunkRows('f1', 3)) },
        },
      } as never
    );

    expect(result.scan.budgets.maxChunks).toBeGreaterThanOrEqual(1);
    expect(result.scan.chunksScanned).toBeGreaterThanOrEqual(1);
  });

  it('asks for a fileName order, the sort the file walk needs to be a total order', async () => {
    // The sort literal is hardcoded inside the paging loop (semanticDataLakeSearch.ts), so pinning
    // the first call pins every page - a one-page fixture is sufficient here. buildFabFileSearchQuery
    // gives no _id tiebreaker to createdAt, so switching this walk to it would silently re-expose
    // the walk to page-boundary loss.
    const search = filesAdapter([{ data: oneFile, hasMore: false, total: 1 }]);
    await semanticDataLakeSearch(baseParams(), {
      db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds: pagingChunkMock([]) } },
    } as never);

    expect(search.mock.calls[0][4]).toEqual({ by: 'fileName', direction: 'asc' });
  });

  it('the file budget marks the scan truncated and warns', async () => {
    const pageOne = Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, fileName: `F${i}.pdf`, tags: [] }));
    const logger = makeLogger();

    const result = await semanticDataLakeSearch(
      { ...baseParams(), logger: logger as never, budgets: { maxFiles: 10, filePageSize: 10 } },
      {
        db: {
          fabfiles: { search: filesAdapter([{ data: pageOne, hasMore: true, total: 50 }]) },
          fabfilechunks: { findVectorsByFabFileIds: pagingChunkMock(chunkRows('f0', 1)) },
        },
      } as never
    );

    expect(result.scan.fileBudgetHit).toBe(true);
    expect(result.scan.truncated).toBe(true);
    expect(result.scan.filesMatching).toBe(50);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('TRUNCATED'), expect.any(Object));
  });

  it('a corpus that exactly fills the chunk budget is NOT reported as truncated', async () => {
    // The probe case: without asking for one row beyond the budget, "exactly full" and
    // "overflowing" look identical and a complete scan gets reported as partial.
    const logger = makeLogger();
    const result = await semanticDataLakeSearch(
      { ...baseParams(), logger: logger as never, budgets: { maxChunks: 5, chunkPageSize: 2 } },
      {
        db: {
          fabfiles: { search: filesAdapter([{ data: oneFile, hasMore: false, total: 1 }]) },
          fabfilechunks: { findVectorsByFabFileIds: pagingChunkMock(chunkRows('f1', 5)) },
        },
      } as never
    );

    expect(result.scan.chunksScanned).toBe(5);
    expect(result.scan.chunkBudgetHit).toBe(false);
    expect(result.scan.truncated).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('a corpus one chunk over the budget IS reported as truncated, and scores exactly the budget', async () => {
    const logger = makeLogger();
    const result = await semanticDataLakeSearch(
      { ...baseParams(), logger: logger as never, budgets: { maxChunks: 5, chunkPageSize: 2 } },
      {
        db: {
          fabfiles: { search: filesAdapter([{ data: oneFile, hasMore: false, total: 1 }]) },
          fabfilechunks: { findVectorsByFabFileIds: pagingChunkMock(chunkRows('f1', 6)) },
        },
      } as never
    );

    // The probe row must not be counted or ranked, or the budget means nothing.
    expect(result.scan.chunksScanned).toBe(5);
    expect(result.scan.chunkBudgetHit).toBe(true);
    expect(result.scan.truncated).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('TRUNCATED'), expect.any(Object));
  });

  it('never requests more than one page beyond the page size - the enforceable memory bound', async () => {
    const findVectors = pagingChunkMock(chunkRows('f1', 25));
    await semanticDataLakeSearch({ ...baseParams(), budgets: { chunkPageSize: 4, maxChunks: 100 } }, {
      db: {
        fabfiles: { search: filesAdapter([{ data: oneFile, hasMore: false, total: 1 }]) },
        fabfilechunks: { findVectorsByFabFileIds: findVectors },
      },
    } as never);

    for (const call of findVectors.mock.calls) {
      expect((call[1] as { limit: number }).limit).toBeLessThanOrEqual(5);
    }
  });

  it('walks a single file across many pages with an advancing cursor, missing no chunk', async () => {
    const findVectors = pagingChunkMock(chunkRows('f1', 7));
    const result = await semanticDataLakeSearch({ ...baseParams(), budgets: { chunkPageSize: 2, maxChunks: 100 } }, {
      db: {
        fabfiles: { search: filesAdapter([{ data: oneFile, hasMore: false, total: 1 }]) },
        fabfilechunks: { findVectorsByFabFileIds: findVectors },
      },
    } as never);

    expect(result.scan.chunksScanned).toBe(7);
    expect(result.scan.truncated).toBe(false);
    const cursors = findVectors.mock.calls.map(c => (c[1] as { afterChunkId?: string }).afterChunkId);
    expect(cursors[0]).toBeUndefined();
    // Strictly increasing after the first page - a stalled cursor would page forever.
    const seen = cursors.slice(1) as string[];
    expect(seen).toEqual([...seen].sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('throws rather than paging forever if the cursor fails to advance', async () => {
    // A repository that ignores afterChunkId would otherwise spin until the page ceiling.
    const stuck = vi.fn().mockResolvedValue(chunkRows('f1', 3));
    await expect(
      semanticDataLakeSearch({ ...baseParams(), budgets: { chunkPageSize: 2, maxChunks: 100 } }, {
        db: {
          fabfiles: { search: filesAdapter([{ data: oneFile, hasMore: false, total: 1 }]) },
          fabfilechunks: { findVectorsByFabFileIds: stuck },
        },
      } as never)
    ).rejects.toThrow('cursor did not advance');
  });
});

/**
 * Truncation is decided on THREE return paths, and until the reporting seam moved to the
 * entrypoints only the first of them said anything: a budgeted scan warned, while a scope whose
 * every file was retrieval-excluded and a scope whose query embedding came back empty both
 * returned a truncated corpus in silence. The metric feeding the `dataLakeScanTruncated` alarm
 * rides the same seam, so a path that reports nothing is a path the alarm cannot see.
 */
describe('semanticDataLakeSearch truncation reporting covers every return path', () => {
  // Over the file budget with a page still pending, so fileBudgetHit is set before either
  // downstream return can be reached. The 'MARK - ' prefix only matters to the exclusion test
  // below; it is inert for the others.
  const overBudgetPage = () =>
    filesAdapter([
      {
        data: Array.from({ length: 2 }, (_, i) => ({ id: `f${i}`, fileName: `MARK - F${i}.pdf`, tags: [] })),
        hasMore: true,
        total: 50,
      },
    ]);

  it('reports truncation when the file budget was hit and EVERY scoped file is retrieval-excluded', async () => {
    const logger = makeLogger();
    const findVectors = pagingChunkMock([]);

    const result = await semanticDataLakeSearch(
      {
        ...baseParams(),
        logger: logger as never,
        budgets: { maxFiles: 2, filePageSize: 2 },
        // Both scoped files carry the marker, so fileIds is empty and the search returns before
        // any ranking - the path that used to drop the signal entirely. Markers are anchored
        // leading + word-boundary, hence the 'MARK - ' prefix rather than a bare substring.
        retrievalFilter: { excludeFilenameMarkers: ['MARK'] },
      },
      {
        db: { fabfiles: { search: overBudgetPage() }, fabfilechunks: { findVectorsByFabFileIds: findVectors } },
      } as never
    );

    expect(findVectors).not.toHaveBeenCalled();
    expect(result.scan.truncated).toBe(true);
    expect(result.scan.fileBudgetHit).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('TRUNCATED'), {
      entrypoint: 'lake-scoped',
      cause: 'files',
    });
  });

  it('reports truncation when the file budget was hit and the query embedding came back empty', async () => {
    const logger = makeLogger();
    mockGenerateEmbedding.mockResolvedValue([]);

    const result = await semanticDataLakeSearch(
      { ...baseParams(), logger: logger as never, budgets: { maxFiles: 2, filePageSize: 2 } },
      {
        db: {
          fabfiles: { search: overBudgetPage() },
          fabfilechunks: { findVectorsByFabFileIds: pagingChunkMock([]) },
        },
      } as never
    );

    // The scope walk hit its budget BEFORE the embedding failed, so the corpus really is
    // incomplete - reporting it as complete here is what made this path invisible.
    expect(result.scan.fileBudgetHit).toBe(true);
    expect(result.scan.truncated).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('TRUNCATED'), {
      entrypoint: 'lake-scoped',
      cause: 'files',
    });
  });

  it('stays silent on a complete scan - an alarm that fires on healthy lakes is worthless', async () => {
    const logger = makeLogger();

    const result = await semanticDataLakeSearch({ ...baseParams(), logger: logger as never }, {
      db: {
        fabfiles: {
          search: filesAdapter([{ data: [{ id: 'f1', fileName: 'F1.pdf', tags: [] }], hasMore: false, total: 1 }]),
        },
        fabfilechunks: { findVectorsByFabFileIds: pagingChunkMock(chunkRows('f1', 2)) },
      },
    } as never);

    expect(result.scan.truncated).toBe(false);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('TRUNCATED'), expect.anything());
  });
});

describe('semanticDataLakeSearch dimension mismatch accounting', () => {
  const oneFile = [{ id: 'f1', fileName: 'F1.pdf', tags: [] }];

  it('counts a wrong-width chunk AND keeps it out of the results', async () => {
    const rows = [
      { id: 'f1-a', fabFileId: 'f1', text: 'good', vector: [1, 0] },
      // Query embedding is [1, 0]; a 3-wide vector belongs to a different model's space.
      { id: 'f1-b', fabFileId: 'f1', text: 'wrong width', vector: [1, 0, 0] },
    ];
    const result = await semanticDataLakeSearch(baseParams(), {
      db: {
        fabfiles: { search: filesAdapter([{ data: oneFile, hasMore: false, total: 1 }]) },
        fabfilechunks: { findVectorsByFabFileIds: pagingChunkMock(rows as never) },
      },
    } as never);

    expect(result.scan.chunksScanned).toBe(2);
    expect(result.scan.chunksSkippedDimensionMismatch).toBe(1);
    expect(result.results.map(r => r.chunkText)).toEqual(['good']);
  });

  it('drops a NaN score instead of letting it outrank every real hit', async () => {
    // cosine of a zero-magnitude vector is 0/0. NaN fails `score < minScore` AND the top-K reject
    // test, so without an explicit guard it lands at rank 1 and serialises as null.
    mockCosine.mockImplementation((_q: unknown, v: unknown) => ((v as number[])[0] === 0 ? NaN : 0.5));
    const result = await semanticDataLakeSearch({ ...baseParams(), topK: 2 }, {
      db: {
        fabfiles: { search: filesAdapter([{ data: oneFile, hasMore: false, total: 1 }]) },
        fabfilechunks: {
          findVectorsByFabFileIds: pagingChunkMock([
            { id: 'f1-bad', fabFileId: 'f1', text: 'degenerate', vector: [0, 0] },
            { id: 'f1-good', fabFileId: 'f1', text: 'real hit', vector: [1, 0] },
          ] as never),
        },
      },
    } as never);

    expect(result.results.map(r => r.chunkText)).toEqual(['real hit']);
    expect(result.results.every(r => Number.isFinite(r.score))).toBe(true);
  });

  it('warns when the WHOLE corpus is the wrong width, but stays quiet for a partial mismatch', async () => {
    const allWrong = makeLogger();
    await semanticDataLakeSearch({ ...baseParams(), logger: allWrong as never }, {
      db: {
        fabfiles: { search: filesAdapter([{ data: oneFile, hasMore: false, total: 1 }]) },
        fabfilechunks: {
          findVectorsByFabFileIds: pagingChunkMock([
            { id: 'f1-a', fabFileId: 'f1', text: 'x', vector: [1, 0, 0] },
          ] as never),
        },
      },
    } as never);
    expect(allWrong.warn).toHaveBeenCalledWith(expect.stringContaining('different dimension'));

    // A few stale chunks mid-revectorize are normal; warning on those would train people to ignore it.
    const partial = makeLogger();
    await semanticDataLakeSearch({ ...baseParams(), logger: partial as never }, {
      db: {
        fabfiles: { search: filesAdapter([{ data: oneFile, hasMore: false, total: 1 }]) },
        fabfilechunks: {
          findVectorsByFabFileIds: pagingChunkMock([
            { id: 'f1-a', fabFileId: 'f1', text: 'x', vector: [1, 0] },
            { id: 'f1-b', fabFileId: 'f1', text: 'y', vector: [1, 0, 0] },
          ] as never),
        },
      },
    } as never);
    expect(partial.warn).not.toHaveBeenCalled();
  });
});

describe('semanticDataLakeSearch determinism', () => {
  const oneFile = [{ id: 'f1', fileName: 'F1.pdf', tags: [] }];

  it('ranks tied chunks the same however the files were partitioned into chunk queries', async () => {
    // Chunks are read per file GROUP, so a group boundary changes the order tied chunks arrive
    // in even though each query is itself _id-sorted. Ties must therefore be broken by an
    // explicit key, not by arrival: with fileGroupSize 2 the reader yields ch1, ch2, ch3, but
    // with fileGroupSize 1 it yields ch1, ch3 (file A) then ch2 (file B).
    mockCosine.mockImplementation(() => 0.8); // exact ties across every chunk
    const twoFiles = [
      { id: 'fA', fileName: 'A.pdf', tags: [] },
      { id: 'fB', fileName: 'B.pdf', tags: [] },
    ];
    const interleaved = [
      { id: 'ch1', fabFileId: 'fA', text: 'a1', vector: [1, 0] },
      { id: 'ch2', fabFileId: 'fB', text: 'b1', vector: [1, 0] },
      { id: 'ch3', fabFileId: 'fA', text: 'a2', vector: [1, 0] },
    ];

    const run = async (fileGroupSize: number) => {
      const res = await semanticDataLakeSearch({ ...baseParams(), topK: 2, budgets: { fileGroupSize } }, {
        db: {
          fabfiles: { search: filesAdapter([{ data: twoFiles, hasMore: false, total: 2 }]) },
          fabfilechunks: { findVectorsByFabFileIds: pagingChunkMock(interleaved as never) },
        },
      } as never);
      return res.results.map(r => r.chunkId);
    };

    expect(await run(1)).toEqual(await run(2));
    expect(await run(2)).toEqual(['ch1', 'ch2']);
  });

  it('keeps the highest-scoring chunks when the corpus exceeds topK', async () => {
    const rows = chunkRows('f1', 5);
    // Ascending scores by text index, so the LAST chunks are the best - they must survive
    // even though the bounded collector saw them last.
    mockCosine.mockImplementation((_q: unknown, v: unknown) => 0.5 + (v as number[])[1]);
    const scored = rows.map((r, i) => ({ ...r, vector: [1, i / 100] }));

    const result = await semanticDataLakeSearch({ ...baseParams(), topK: 2, budgets: { chunkPageSize: 2 } }, {
      db: {
        fabfiles: { search: filesAdapter([{ data: oneFile, hasMore: false, total: 1 }]) },
        fabfilechunks: { findVectorsByFabFileIds: pagingChunkMock(scored as never) },
      },
    } as never);

    expect(result.results.map(r => r.chunkId)).toEqual(['f1-c0004', 'f1-c0003']);
  });
});

describe('semanticDataLakeSearch per-document cap', () => {
  // Three documents, four chunks each, scores descending strictly by chunk index across the
  // whole corpus: dA beats every dB chunk, which beats every dC chunk. Uncapped, dA alone owns
  // the entire top-4 - the crowding the cap exists to break.
  const THREE_DOCS = [
    { id: 'dA', fileName: 'A.pdf', tags: [] },
    { id: 'dB', fileName: 'B.pdf', tags: [] },
    { id: 'dC', fileName: 'C.pdf', tags: [] },
  ];
  const rankedCorpus = [...chunkRows('dA', 4), ...chunkRows('dB', 4), ...chunkRows('dC', 4)].map((row, i) => ({
    ...row,
    vector: [1, (100 - i) / 1000],
  }));

  const runCapped = async (maxChunksPerFile: number | undefined, topK = 4) => {
    mockCosine.mockImplementation((_q: unknown, v: unknown) => (v as number[])[1]);
    const result = await semanticDataLakeSearch({ ...baseParams(), topK, budgets: { maxChunksPerFile } }, {
      db: {
        fabfiles: { search: filesAdapter([{ data: THREE_DOCS, hasMore: false, total: 3 }]) },
        fabfilechunks: { findVectorsByFabFileIds: pagingChunkMock(rankedCorpus as never) },
      },
    } as never);
    return result.results;
  };

  it('is off by default: one document may still own the whole top-K', async () => {
    // Pins the pre-cap behavior as the DEFAULT, so enabling the cap is opt-in and this change
    // cannot quietly alter what every existing install serves.
    expect((await runCapped(undefined)).map(r => r.fileId)).toEqual(['dA', 'dA', 'dA', 'dA']);
  });

  it('caps a crowding document and admits the next documents instead', async () => {
    const capped = await runCapped(2);

    expect(capped.map(r => r.fileId)).toEqual(['dA', 'dA', 'dB', 'dB']);
    // Still exactly topK, and still best-first: the cap changed WHICH chunks won the contested
    // slots, not how many were served or the order they are served in.
    expect(capped).toHaveLength(4);
    expect(capped.map(r => r.score)).toEqual([...capped.map(r => r.score)].sort((a, b) => b - a));
  });

  it('never serves fewer results than the uncapped search would', async () => {
    // The backfill pass. A lake whose only match is one long document has no diversity to offer,
    // and a cap that shrank the result set there would be a straight quality regression - the
    // reason this can ship enabled on a corpus nobody has measured crowding on.
    mockCosine.mockImplementation((_q: unknown, v: unknown) => (v as number[])[1]);
    const oneDoc = [{ id: 'dA', fileName: 'A.pdf', tags: [] }];
    const rows = chunkRows('dA', 4).map((row, i) => ({ ...row, vector: [1, (100 - i) / 1000] }));

    const result = await semanticDataLakeSearch({ ...baseParams(), topK: 4, budgets: { maxChunksPerFile: 2 } }, {
      db: {
        fabfiles: { search: filesAdapter([{ data: oneDoc, hasMore: false, total: 1 }]) },
        fabfilechunks: { findVectorsByFabFileIds: pagingChunkMock(rows as never) },
      },
    } as never);

    expect(result.results).toHaveLength(4);
    expect(result.results.map(r => r.chunkId)).toEqual(['dA-c0000', 'dA-c0001', 'dA-c0002', 'dA-c0003']);
  });

  it('a cap of 1 reaches every document before serving any document twice', async () => {
    const capped = await runCapped(1);

    // Three distinct documents in four slots, where the uncapped search reaches exactly one.
    expect(new Set(capped.map(r => r.fileId)).size).toBe(3);
    // The fourth slot is a backfill (only three documents exist), and the re-sort puts it back in
    // score order rather than at the end - which is why this asserts the SET reached plus the
    // ordering, not a positional sequence that would just re-encode the sort.
    expect(capped.map(r => r.chunkId)).toEqual(['dA-c0000', 'dA-c0001', 'dB-c0000', 'dC-c0000']);
    expect(capped.map(r => r.score)).toEqual([...capped.map(r => r.score)].sort((a, b) => b - a));
  });

  it('a zero cap is disabled, not a cap of zero', async () => {
    // The trap in threading this through: a budget resolver that clamps to "at least 1" turns
    // the disabled value into the most aggressive one, and a `|| fallback` turns it back into
    // the default. Either way the operator's setting means the opposite of what it says.
    expect((await runCapped(0)).map(r => r.fileId)).toEqual(['dA', 'dA', 'dA', 'dA']);
  });

  it('cannot promote a document whose chunks never survived the widened candidate pool', async () => {
    // The documented residual limitation, made concrete: with topK 2 and a cap of 1, the widened
    // pool is 2 * DIVERSITY_CANDIDATE_POOL_FACTOR (3) = 6. dA alone contributes 8 chunks, all
    // scoring above dB's single chunk - so the pool fills entirely with dA before dB's chunk is
    // ever offered to it, and the cap never gets a chance to see dB at all. Enforcement at the
    // merge only chooses among whatever reached the merge; it cannot recover a document a stream
    // upstream of it already discarded.
    mockCosine.mockImplementation((_q: unknown, v: unknown) => (v as number[])[1]);
    const twoDocs = [
      { id: 'dA', fileName: 'A.pdf', tags: [] },
      { id: 'dB', fileName: 'B.pdf', tags: [] },
    ];
    const corpus = [
      ...chunkRows('dA', 8).map((row, i) => ({ ...row, vector: [1, (90 - i) / 100] })), // 0.90..0.83
      ...chunkRows('dB', 1).map(row => ({ ...row, vector: [1, 0.01] })), // far below every dA chunk
    ];

    const result = await semanticDataLakeSearch({ ...baseParams(), topK: 2, budgets: { maxChunksPerFile: 1 } }, {
      db: {
        fabfiles: { search: filesAdapter([{ data: twoDocs, hasMore: false, total: 2 }]) },
        fabfilechunks: { findVectorsByFabFileIds: pagingChunkMock(corpus as never) },
      },
    } as never);

    expect(result.results.map(r => r.fileId)).toEqual(['dA', 'dA']);
    expect(result.results.some(r => r.fileId === 'dB')).toBe(false);
  });
});

/**
 * Per-lake supersession collapse at the lake-scoped entrypoint. Both halves of the opt-in are
 * exercised - the admin flag AND the resolved lakes - because either alone must leave today's
 * behaviour byte-identical.
 */
describe('semanticDataLakeSearch supersession collapse', () => {
  const LAKES = [{ id: 'lakeX', datalakeTag: 'datalake:x' }];

  // Two generations of one document plus an unrelated file, all in one lake.
  const twoGenerations = () => [
    {
      id: 'old',
      fileName: 'Protocol.pdf',
      tags: [{ name: 'datalake:x' }],
      vectorized: true,
      createdAt: new Date('2024-01-01'),
    },
    {
      id: 'new',
      fileName: 'Protocol.pdf',
      tags: [{ name: 'datalake:x' }],
      vectorized: true,
      createdAt: new Date('2025-01-01'),
    },
    { id: 'other', fileName: 'Other.pdf', tags: [{ name: 'datalake:x' }], vectorized: true },
  ];

  const adaptersFor = (files: unknown[], findVectors: ReturnType<typeof vi.fn>) => ({
    db: {
      fabfiles: { search: vi.fn().mockResolvedValue({ data: files, hasMore: false, total: files.length }) },
      fabfilechunks: { findVectorsByFabFileIds: findVectors },
    },
  });

  const collapseParams = () => ({ ...baseParams(), lakes: LAKES, supersessionCollapseEnabled: true });

  it('drops the older generation BEFORE the chunk scan, so the budget goes to other files', async () => {
    const findVectors = vi.fn().mockResolvedValue([]);
    const result = await semanticDataLakeSearch(collapseParams(), adaptersFor(twoGenerations(), findVectors) as never);
    expect(findVectors.mock.calls[0][0]).toEqual(['new', 'other']);
    expect(result.supersession.count).toBe(1);
    expect(result.supersession.sample[0]).toMatchObject({ fileId: 'old', tier: 'fileName', supersededBy: 'new' });
    expect(result.supersession.partial).toBe(true);
  });

  it('spends the recovered top-K on another document instead of returning fewer passages', async () => {
    // Both generations out-score the unrelated file, so at topK 2 they fill the result set between
    // them. The collapse must hand the freed slot to `other`, not shorten the output.
    mockCosine.mockImplementation((_q: unknown, v: unknown) => (v as number[])[1]);
    const chunks = [
      { id: 'ch-1old', fabFileId: 'old', vector: [1, 0.9], text: 'old' },
      { id: 'ch-2new', fabFileId: 'new', vector: [1, 0.9], text: 'new' },
      { id: 'ch-3other', fabFileId: 'other', vector: [1, 0.5], text: 'other' },
    ];
    const run = (params: SemanticDataLakeSearchParams) =>
      semanticDataLakeSearch(
        { ...params, topK: 2 },
        adaptersFor(twoGenerations(), pagingChunkMock(chunks as never)) as never
      );

    const off = await run({ ...baseParams(), lakes: LAKES });
    expect(off.results.map(r => r.fileId).sort()).toEqual(['new', 'old']);

    const on = await run(collapseParams());
    expect(on.results).toHaveLength(off.results.length);
    expect(on.results.map(r => r.fileId).sort()).toEqual(['new', 'other']);
  });

  /**
   * Ordering guard, and the reason the collapse sits after `groupFilesByEmbeddingModel` rather than
   * before it: the alternate-model buckets reach the ANN phase only when vector search is enabled,
   * which is off by default, so a foreign-model file is a hard drop on the default deployment. If it
   * could win an identity key the lake would serve NEITHER generation of that document.
   */
  it('collapses AFTER the embedding-model split: a foreign-model newest generation does not suppress the older one', async () => {
    const files = [
      {
        id: 'old',
        fileName: 'Protocol.pdf',
        tags: [{ name: 'datalake:x' }],
        vectorized: true,
        createdAt: new Date('2024-01-01'),
        embeddingModel: 'text-embedding-ada-002',
        chunkCount: 1,
        vectorizedChunkCount: 1,
      },
      {
        id: 'new',
        fileName: 'Protocol.pdf',
        tags: [{ name: 'datalake:x' }],
        vectorized: true,
        createdAt: new Date('2025-01-01'),
        embeddingModel: 'text-embedding-3-small',
        chunkCount: 1,
        vectorizedChunkCount: 1,
      },
    ];
    const findVectors = vi.fn().mockResolvedValue([]);
    const result = await semanticDataLakeSearch(collapseParams(), adaptersFor(files, findVectors) as never);
    expect(findVectors.mock.calls[0][0]).toEqual(['old']);
    expect(result.supersession.count).toBe(0);
    expect(result.embeddingMismatch.excludedFiles.count).toBe(1);
  });

  it('no two ranked chunks come from members sharing a source identity within one lake', async () => {
    const chunkFor = (fileId: string) => ({ id: `ch-${fileId}`, fabFileId: fileId, vector: [1, 0], text: fileId });
    const findVectors = pagingChunkMock(twoGenerations().map(f => chunkFor(f.id)) as never);
    const result = await semanticDataLakeSearch(collapseParams(), adaptersFor(twoGenerations(), findVectors) as never);
    const names = result.results.map(r => r.fileName);
    expect(new Set(names).size).toBe(names.length);
    expect(result.results.map(r => r.fileId).sort()).toEqual(['new', 'other']);
  });

  it('surfaces the suppression through describeSearchLimitations, naming ids and the tier', async () => {
    const result = await semanticDataLakeSearch(
      collapseParams(),
      adaptersFor(twoGenerations(), vi.fn().mockResolvedValue([])) as never
    );
    const prose = describeSearchLimitations(result);
    expect(prose).toContain('old');
    expect(prose).toContain('new');
    expect(prose).toContain('fileName');
    // Reported, but NOT partial: the corpus is complete, just deduplicated. See isPartialSearch.
    expect(isPartialSearch(result)).toBe(false);
  });

  it('flag off (the shipped default): nothing collapses even with lakes resolved', async () => {
    const findVectors = vi.fn().mockResolvedValue([]);
    const result = await semanticDataLakeSearch(
      { ...baseParams(), lakes: LAKES },
      adaptersFor(twoGenerations(), findVectors) as never
    );
    expect(findVectors.mock.calls[0][0]).toEqual(['old', 'new', 'other']);
    expect(result.supersession).toEqual({ count: 0, sample: [], partial: false });
    expect(isPartialSearch(result)).toBe(false);
  });

  it('flag on but no lakes resolved: nothing is attributable, so nothing collapses', async () => {
    const findVectors = vi.fn().mockResolvedValue([]);
    const result = await semanticDataLakeSearch(
      { ...baseParams(), supersessionCollapseEnabled: true },
      adaptersFor(twoGenerations(), findVectors) as never
    );
    expect(findVectors.mock.calls[0][0]).toEqual(['old', 'new', 'other']);
    expect(result.supersession.count).toBe(0);
  });

  it('collapses AFTER the availability partition: a mid-reindex newest generation does not suppress the servable older one', async () => {
    const files = [
      {
        id: 'old',
        fileName: 'Protocol.pdf',
        tags: [{ name: 'datalake:x' }],
        vectorized: true,
        createdAt: new Date('2024-01-01'),
        chunkCount: 4,
        vectorizedChunkCount: 4,
      },
      {
        // Mid-reindex: chunks committed, none vectorized yet - withheld upstream of the collapse.
        id: 'new',
        fileName: 'Protocol.pdf',
        tags: [{ name: 'datalake:x' }],
        vectorized: true,
        createdAt: new Date('2025-01-01'),
        chunkCount: 4,
        vectorizedChunkCount: 0,
      },
    ];
    const findVectors = vi.fn().mockResolvedValue([]);
    const result = await semanticDataLakeSearch(collapseParams(), adaptersFor(files, findVectors) as never);
    // The older generation still ranks - the lake is not left contributing nothing for this document.
    expect(findVectors.mock.calls[0][0]).toEqual(['old']);
    expect(result.supersession.count).toBe(0);
    expect(result.retrievalUnavailable.partial).toBe(true);
  });

  it('never collapses across lakes', async () => {
    const findVectors = vi.fn().mockResolvedValue([]);
    const files = [
      { id: 'x1', fileName: 'Protocol.pdf', tags: [{ name: 'datalake:x' }], vectorized: true },
      { id: 'y1', fileName: 'Protocol.pdf', tags: [{ name: 'datalake:y' }], vectorized: true },
    ];
    const result = await semanticDataLakeSearch(
      {
        ...collapseParams(),
        lakes: [...LAKES, { id: 'lakeY', datalakeTag: 'datalake:y' }],
      },
      adaptersFor(files, findVectors) as never
    );
    expect(findVectors.mock.calls[0][0]).toEqual(['x1', 'y1']);
    expect(result.supersession.count).toBe(0);
  });
});

describe('fileScopedSemanticSearch (allow-list scope)', () => {
  const scopedParams = (fileIds: string[]) => ({
    query: 'stage III treatment',
    fileIds,
    embeddingModel: 'text-embedding-ada-002' as SemanticDataLakeSearchParams['embeddingModel'],
    apiKeyTable: { openai: 'k' },
  });

  const scopedAdapters = (opts: {
    files?: { id: string; fileName: string; tags?: { name: string }[] }[];
    chunks?: { id: string; fabFileId: string; vector: number[]; text: string }[];
  }) => {
    const getAccessibleFiles = vi.fn().mockResolvedValue(opts.files ?? []);
    const findVectorsByFabFileIds = pagingChunkMock((opts.chunks ?? []) as never);
    return {
      adapters: { db: { fabfiles: { getAccessibleFiles }, fabfilechunks: { findVectorsByFabFileIds } } },
      getAccessibleFiles,
      findVectorsByFabFileIds,
    };
  };

  /**
   * Decision guard, not a description of a limitation: a curated kbScope is an explicit allow-list,
   * so this entrypoint must never collapse superseded members even though it shares the ranking core
   * with the lake-scoped one. It has no lake context to pass, and adding one would silently override
   * a human's curation. Asserted here because a well-meaning "why is this asymmetric" edit is the
   * likely way it gets broken.
   */
  it('does NOT collapse superseded members, even for two identically named files', async () => {
    const files = [
      { id: 'old', fileName: 'Protocol.pdf', tags: [{ name: 'datalake:x' }], createdAt: new Date('2024-01-01') },
      { id: 'new', fileName: 'Protocol.pdf', tags: [{ name: 'datalake:x' }], createdAt: new Date('2025-01-01') },
    ];
    const { adapters, findVectorsByFabFileIds } = scopedAdapters({ files });
    const result = await fileScopedSemanticSearch(scopedParams(['old', 'new']), adapters as never);
    expect(findVectorsByFabFileIds.mock.calls[0][0]).toEqual(['new', 'old']);
    expect(result.supersession).toEqual({ count: 0, sample: [], partial: false });
  });

  it('searches vectors for EXACTLY the scoped file ids and returns only their hits', async () => {
    const { adapters, getAccessibleFiles, findVectorsByFabFileIds } = scopedAdapters({
      files: [{ id: 'in-scope', fileName: 'InScope.pdf', tags: [] }],
      chunks: [{ id: 'ch1', fabFileId: 'in-scope', vector: [1, 0], text: 'scoped content' }],
    });

    const result = await fileScopedSemanticSearch(scopedParams(['in-scope']), adapters as never);

    expect(getAccessibleFiles).toHaveBeenCalledWith(['in-scope'], { deletedAt: null, archivedAt: null });
    expect(findVectorsByFabFileIds.mock.calls[0][0]).toEqual(['in-scope']);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].fileId).toBe('in-scope');
  });

  it('empty scope returns empty WITHOUT any DB access (scoped-to-nothing contract)', async () => {
    const { adapters, getAccessibleFiles, findVectorsByFabFileIds } = scopedAdapters({});

    const result = await fileScopedSemanticSearch(scopedParams([]), adapters as never);

    expect(result.results).toEqual([]);
    expect(getAccessibleFiles).not.toHaveBeenCalled();
    expect(findVectorsByFabFileIds).not.toHaveBeenCalled();
  });

  it('deleted/archived files in scope contribute nothing (metadata fetch filters them)', async () => {
    // getAccessibleFiles applies { deletedAt: null, archivedAt: null }, so a scope whose
    // only file is deleted resolves to no live files and no vectors are loaded.
    const { adapters, findVectorsByFabFileIds } = scopedAdapters({ files: [] });

    const result = await fileScopedSemanticSearch(scopedParams(['deleted-file']), adapters as never);

    expect(result.results).toEqual([]);
    expect(findVectorsByFabFileIds).not.toHaveBeenCalled();
  });

  it('files with no vector chunks yield an empty result, not an error', async () => {
    const { adapters } = scopedAdapters({
      files: [{ id: 'in-scope', fileName: 'NoVectors.pdf', tags: [] }],
      chunks: [],
    });

    const result = await fileScopedSemanticSearch(scopedParams(['in-scope']), adapters as never);

    expect(result.results).toEqual([]);
    expect(result.filesInScope).toBe(1);
  });

  it('a chunk whose file dropped out of the live set is skipped', async () => {
    const { adapters } = scopedAdapters({
      files: [{ id: 'live', fileName: 'Live.pdf', tags: [] }],
      chunks: [
        { id: 'ch1', fabFileId: 'live', vector: [1, 0], text: 'live content' },
        { id: 'ch2', fabFileId: 'gone', vector: [1, 0], text: 'orphan content' },
      ],
    });

    const result = await fileScopedSemanticSearch(scopedParams(['live', 'gone']), adapters as never);

    expect(result.results.map(r => r.fileId)).toEqual(['live']);
  });

  it('scans an unordered allow-list in a stable order so an over-budget scope drops the same files', async () => {
    // getAccessibleFiles imposes no order; without sorting, WHICH files a budget drops would
    // be Mongo's natural order and could differ between two identical calls.
    const { adapters, findVectorsByFabFileIds } = scopedAdapters({
      files: [
        { id: 'c', fileName: 'C.pdf', tags: [] },
        { id: 'a', fileName: 'A.pdf', tags: [] },
        { id: 'b', fileName: 'B.pdf', tags: [] },
      ],
    });

    const result = await fileScopedSemanticSearch(
      { ...scopedParams(['a', 'b', 'c']), budgets: { maxFiles: 2 } },
      adapters as never
    );

    expect(findVectorsByFabFileIds.mock.calls[0][0]).toEqual(['a', 'b']);
    expect(result.scan.fileBudgetHit).toBe(true);
    expect(result.scan.truncated).toBe(true);
    expect(result.scan.filesMatching).toBe(3);
  });

  /**
   * The Entrypoint dimension is what tells an operator WHICH surface truncated - a curated agent
   * kbScope and a lake search have different fixes (recurate vs raise the budget), and the alarm
   * is otherwise one undifferentiated count.
   */
  it('attributes the allow-list surface to its own entrypoint, so a truncating surface is identifiable', async () => {
    const logger = makeLogger();
    const { adapters } = scopedAdapters({
      files: [
        { id: 'a', fileName: 'A.pdf', tags: [] },
        { id: 'b', fileName: 'B.pdf', tags: [] },
      ],
    });

    const result = await fileScopedSemanticSearch(
      { ...scopedParams(['a', 'b']), logger: logger as never, budgets: { maxFiles: 1 } },
      adapters as never
    );

    expect(result.scan.truncated).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('TRUNCATED'), {
      entrypoint: 'file-scoped',
      cause: 'files',
    });
  });

  it('reports a complete allow-list scan as not truncated', async () => {
    const { adapters } = scopedAdapters({
      files: [{ id: 'a', fileName: 'A.pdf', tags: [] }],
      chunks: [{ id: 'ch1', fabFileId: 'a', vector: [1, 0], text: 'x' }],
    });

    const result = await fileScopedSemanticSearch(scopedParams(['a']), adapters as never);

    expect(result.scan.truncated).toBe(false);
    // The pre-existing flat counters must keep agreeing with the new accounting block.
    expect(result.totalChunksSearched).toBe(result.scan.chunksScanned);
    expect(result.filesInScope).toBe(result.scan.filesScoped);
  });

  it('a curated allow-list spanning two models serves both via ANN (mixed-model cutover inherited for free)', async () => {
    const readyStamp = new Date(Date.now() - 120_000);
    const SMALL_3 = 'text-embedding-3-small';
    const getAccessibleFiles = vi.fn().mockResolvedValue([
      {
        id: 'primary',
        fileName: 'Primary.pdf',
        tags: [],
        embeddingModel: 'text-embedding-ada-002',
        vectorizedChunkCount: 1,
        chunkEmbeddingModelStampedAt: readyStamp,
      },
      {
        id: 'alt',
        fileName: 'Alt.pdf',
        tags: [],
        embeddingModel: SMALL_3,
        vectorizedChunkCount: 1,
        chunkEmbeddingModelStampedAt: readyStamp,
      },
    ]);
    const findVectorsByFabFileIds = pagingChunkMock([]);
    const vectorSearch = vi.fn((_ids: string[], _vec: number[], model: string) =>
      Promise.resolve(
        model === SMALL_3
          ? [{ id: 'a-c0', fabFileId: 'alt', text: 'alt hit', score: 0.9 }]
          : [{ id: 'p-c0', fabFileId: 'primary', text: 'primary hit', score: 0.9 }]
      )
    );
    const getAtlasIndexStatus = vi.fn().mockResolvedValue({ queryable: true, status: 'READY' });

    const result = await fileScopedSemanticSearch({ ...scopedParams(['primary', 'alt']), vectorSearchEnabled: true }, {
      db: {
        fabfiles: { getAccessibleFiles },
        fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus },
      },
    } as never);

    expect(vectorSearch).toHaveBeenCalledTimes(2);
    expect(result.results.map(r => r.fileId).sort()).toEqual(['alt', 'primary']);
    expect(result.embeddingMismatch.excludedFiles.count).toBe(0);
  });
});

describe('semanticDataLakeSearch Atlas $vectorSearch cutover', () => {
  const readyStamp = new Date(Date.now() - 120_000); // past the 60s mongot indexing lag
  const freshStamp = new Date(Date.now() - 10_000); // still within the lag, not queryable yet

  /** One file whose search-result row carries the ann-eligibility metadata rankChunksForFiles reads. */
  const annFile = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    fileName: `${id}.pdf`,
    tags: [],
    embeddingModel: 'text-embedding-ada-002',
    vectorizedChunkCount: 1,
    chunkEmbeddingModelStampedAt: readyStamp,
    ...overrides,
  });

  const PRIMARY_MODEL = 'text-embedding-ada-002';

  /**
   * Keyed on the `model` argument every call carries, so an alternate-model ANN attempt (which
   * queries a DIFFERENT model than the primary) gets its own independent response instead of
   * silently inheriting the primary model's mocked hits/queryable status - a flat
   * `mockResolvedValue` would let a foreign-model file elsewhere in scope spuriously "hit" on the
   * primary model's fixture data once the alternate phase can fire.
   *
   * `annHits`/`indexQueryable` remain as shorthand for the PRIMARY model only, so every
   * single-model test written before the multi-model cutover keeps working unchanged - a model
   * absent from `annHitsByModel`/`queryableModels` defaults to "no hits"/"not queryable", exactly
   * today's behavior for any model the caller didn't opt into.
   */
  const annAdapters = (args: {
    files: ReturnType<typeof annFile>[];
    scanChunks?: { id: string; fabFileId: string; text: string; vector: number[] }[];
    annHits?: { id: string; fabFileId: string; text: string; score: number }[];
    indexQueryable?: boolean;
    annHitsByModel?: Record<string, { id: string; fabFileId: string; text: string; score: number }[]>;
    queryableModels?: string[];
  }) => {
    const findVectorsByFabFileIds = pagingChunkMock(args.scanChunks ?? []);
    const hitsByModel: Record<string, { id: string; fabFileId: string; text: string; score: number }[]> = {
      ...(args.annHitsByModel ?? {}),
    };
    if (args.annHits !== undefined) hitsByModel[PRIMARY_MODEL] = args.annHits;
    const queryableModels = new Set(args.queryableModels ?? (args.indexQueryable === false ? [] : [PRIMARY_MODEL]));
    const vectorSearch = vi.fn((_fileIds: string[], _vector: number[], model: string) =>
      Promise.resolve(hitsByModel[model] ?? [])
    );
    const getAtlasIndexStatus = vi.fn((model: string) =>
      Promise.resolve({ queryable: queryableModels.has(model), status: 'READY' })
    );
    return {
      search: filesAdapter([{ data: args.files, hasMore: false, total: args.files.length }]),
      findVectorsByFabFileIds,
      vectorSearch,
      getAtlasIndexStatus,
    };
  };

  it('off by default: never calls vectorSearch even when the adapter and a ready file are present', async () => {
    const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
      files: [annFile('f1')],
      scanChunks: chunkRows('f1', 2),
    });

    const result = await semanticDataLakeSearch(baseParams(), {
      db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
    } as never);

    expect(vectorSearch).not.toHaveBeenCalled();
    expect(getAtlasIndexStatus).not.toHaveBeenCalled();
    expect(result.scan.annFilesQueried).toBe(0);
    expect(result.scan.chunksScanned).toBe(2);
  });

  it('falls back to scan-only when the model has no queryable Atlas index yet', async () => {
    const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
      files: [annFile('f1')],
      scanChunks: chunkRows('f1', 2),
      indexQueryable: false,
    });

    const result = await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true }, {
      db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
    } as never);

    expect(getAtlasIndexStatus).toHaveBeenCalled();
    expect(vectorSearch).not.toHaveBeenCalled();
    expect(result.scan.annFilesQueried).toBe(0);
    expect(result.scan.chunksScanned).toBe(2);
  });

  it('keeps a freshly-stamped file on the scan path (mongot indexing lag not yet elapsed)', async () => {
    const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
      files: [annFile('f1', { chunkEmbeddingModelStampedAt: freshStamp })],
      scanChunks: chunkRows('f1', 2),
    });

    const result = await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true }, {
      db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
    } as never);

    expect(vectorSearch).not.toHaveBeenCalled();
    expect(result.scan.annFilesQueried).toBe(0);
    expect(result.scan.chunksScanned).toBe(2);
  });

  it('splits per file: a ready file goes to Atlas, a fresh one stays on scan, and both merge into one ranking', async () => {
    const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
      files: [annFile('ready'), annFile('fresh', { chunkEmbeddingModelStampedAt: freshStamp })],
      scanChunks: chunkRows('fresh', 1),
      annHits: [{ id: 'ready-c0', fabFileId: 'ready', text: 'ann hit', score: 0.95 }],
    });

    const result = await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true }, {
      db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
    } as never);

    expect(vectorSearch).toHaveBeenCalledWith(['ready'], expect.anything(), 'text-embedding-ada-002', {
      limit: expect.any(Number),
    });
    expect(findVectorsByFabFileIds.mock.calls[0][0]).toEqual(['fresh']);
    expect(result.scan.annFilesQueried).toBe(1);
    expect(result.scan.annHits).toBe(1);
    expect(result.results.map(r => r.fileId).sort()).toEqual(['fresh', 'ready']);
  });

  describe("the per-document cap's widened ANN limit", () => {
    // Every other cap test drives the SCAN path, where the widening is invisible (scanAndRank's
    // read volume is bounded by maxChunks, not topK). The ANN backends are the only place the
    // widened pool becomes a bigger request, so this is the one asserting the limit they receive.
    const annLimitFor = async (budgets: { maxChunksPerFile?: number } | undefined, topK: number) => {
      const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
        files: [annFile('f1')],
        annHits: [{ id: 'f1-c0', fabFileId: 'f1', text: 'ann hit', score: 0.95 }],
      });

      await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true, topK, budgets }, {
        db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
      } as never);

      return (vectorSearch.mock.calls[0][3] as { limit: number }).limit;
    };

    it('asks for exactly topK when the cap is off', async () => {
      expect(await annLimitFor(undefined, 4)).toBe(4);
      expect(await annLimitFor({ maxChunksPerFile: 0 }, 4)).toBe(4);
    });

    it('asks for topK * DIVERSITY_CANDIDATE_POOL_FACTOR when the cap can bind', async () => {
      // The factor is 3, so a topK of 4 becomes 12 - the headroom capChunksPerFile needs before it
      // can promote anything. A stream still bounded at topK would have discarded the other
      // documents' chunks upstream of the cap.
      expect(await annLimitFor({ maxChunksPerFile: 2 }, 4)).toBe(12);
    });

    it('stays at topK for a cap that cannot bind, rather than tripling the request for nothing', async () => {
      // A cap at or above topK never holds a chunk back (the admit pass fills topK before any one
      // document reaches the cap), and the setting declares no max, so this is reachable config -
      // it must not cost a 3x ANN request for a provably identical result.
      expect(await annLimitFor({ maxChunksPerFile: 4 }, 4)).toBe(4);
      expect(await annLimitFor({ maxChunksPerFile: 20 }, 4)).toBe(4);
    });
  });

  it('does not warn "nothing could be compared" when Atlas served every rankable file', async () => {
    // A foreign (off-model) file elsewhere in scope makes mismatchReport.partial true; the ready
    // file goes entirely through Atlas, so scanAndRank never runs and scores 0 chunks. Without the
    // annResult.hitsReturned guard, this combination false-fires the "nothing could be compared"
    // warning even though Atlas found a real hit.
    const logger = makeLogger();
    const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
      files: [annFile('ready'), annFile('foreign', { embeddingModel: 'text-embedding-3-small' })],
      annHits: [{ id: 'ready-c0', fabFileId: 'ready', text: 'ann hit', score: 0.95 }],
    });

    await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true, logger: logger as never }, {
      db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
    } as never);

    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('nothing could be compared'));
  });

  it('falls back to scan for its files when $vectorSearch itself throws, instead of failing the whole search', async () => {
    const logger = makeLogger();
    const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
      files: [annFile('ready')],
      scanChunks: chunkRows('ready', 2),
    });
    vectorSearch.mockRejectedValueOnce(new Error('mongot unavailable'));

    const result = await semanticDataLakeSearch(
      { ...baseParams(), vectorSearchEnabled: true, logger: logger as never },
      {
        db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
      } as never
    );

    expect(result.scan.annFilesQueried).toBe(0);
    expect(result.scan.chunksScanned).toBe(2);
    expect(result.results.map(r => r.fileId)).toEqual(['ready', 'ready']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ANN vector search failed'),
      expect.objectContaining({ fileCount: 1, backend: 'atlas' })
    );
  });

  it('rebuckets a ready file onto scan when the index is queryable but returns zero hits for it (indexing lag, not a throw)', async () => {
    const logger = makeLogger();
    const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
      files: [annFile('ready')],
      scanChunks: chunkRows('ready', 2),
      annHits: [],
    });

    const result = await semanticDataLakeSearch(
      { ...baseParams(), vectorSearchEnabled: true, logger: logger as never },
      {
        db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
      } as never
    );

    expect(result.scan.annFilesQueried).toBe(0);
    expect(result.scan.chunksScanned).toBe(2);
    expect(result.results.map(r => r.fileId)).toEqual(['ready', 'ready']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('returned no hits for ready files'),
      expect.objectContaining({ fileCount: 1 })
    );
  });

  it('rebuckets only the ready file Atlas actually missed, not the whole batch', async () => {
    const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
      files: [annFile('covered'), annFile('missed')],
      scanChunks: chunkRows('missed', 1),
      annHits: [{ id: 'covered-c0', fabFileId: 'covered', text: 'ann hit', score: 0.95 }],
    });

    const result = await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true }, {
      db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
    } as never);

    expect(result.scan.annFilesQueried).toBe(1);
    expect(result.scan.chunksScanned).toBe(1);
    expect(result.results.map(r => r.fileId).sort()).toEqual(['covered', 'missed']);
  });

  /**
   * The alarm for the exact way this cutover failed in production: enabled, indexed, and silently
   * never running because no chunk carried an `embeddingModel`. Every arm asserts the `reason`,
   * since that is the only part of the log that tells an operator which of three fixes applies.
   */
  describe('flag-on-but-idle alarm', () => {
    const ALARM = 'ANN served nothing';

    it('reports no-ready-files when the index is queryable but nothing passed the readiness gate', async () => {
      const logger = makeLogger();
      const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
        files: [annFile('f1', { chunkEmbeddingModelStampedAt: undefined })],
        scanChunks: chunkRows('f1', 2),
      });

      await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true, logger: logger as never }, {
        db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
      } as never);

      expect(vectorSearch).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(ALARM),
        // Zero within the lag is what separates this from the transient case below: nothing here
        // is waiting on anything, the chunk `embeddingModel` backfill simply never ran.
        expect.objectContaining({
          reason: 'no-ready-files',
          backend: 'atlas',
          rankableFiles: 1,
          stampedWithinLagFiles: 0,
        })
      );
    });

    it('reports ready-files-within-lag when the whole lake only just finished vectorizing', async () => {
      const logger = makeLogger();
      const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
        files: [annFile('f1', { chunkEmbeddingModelStampedAt: freshStamp })],
        scanChunks: chunkRows('f1', 2),
      });

      await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true, logger: logger as never }, {
        db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
      } as never);

      // Same observable state as no-ready-files (zero eligible files, scan-only retrieval) but the
      // opposite fix: this one resolves itself within one lag window, so pointing an operator at
      // the backfill would send them after work that has already run.
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(ALARM),
        expect.objectContaining({ reason: 'ready-files-within-lag', stampedWithinLagFiles: 1 })
      );
    });

    it('keeps no-ready-files when only SOME files are inside the lag, and counts them', async () => {
      const logger = makeLogger();
      const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
        files: [
          annFile('never-stamped', { chunkEmbeddingModelStampedAt: undefined }),
          annFile('just-stamped', { chunkEmbeddingModelStampedAt: freshStamp }),
        ],
        scanChunks: chunkRows('never-stamped', 2),
      });

      await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true, logger: logger as never }, {
        db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
      } as never);

      // Waiting would never fix `never-stamped`, so the backfill reason wins - and the count is
      // what tells the operator part of the lake needs nothing but time.
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(ALARM),
        expect.objectContaining({ reason: 'no-ready-files', rankableFiles: 2, stampedWithinLagFiles: 1 })
      );
    });

    it('still fires when an alternate model was embedded but its ANN query threw', async () => {
      const ALT_MODEL = 'text-embedding-3-small';
      const logger = makeLogger();
      const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
        files: [
          annFile('primary-unstamped', { chunkEmbeddingModelStampedAt: undefined }),
          annFile('alt', { embeddingModel: ALT_MODEL }),
        ],
        scanChunks: chunkRows('primary-unstamped', 2),
        queryableModels: ['text-embedding-ada-002', ALT_MODEL],
      });
      vectorSearch.mockImplementation((_ids: string[], _vec: number[], _model: string) =>
        Promise.reject(new Error('alt index down'))
      );

      const result = await semanticDataLakeSearch(
        { ...baseParams(), vectorSearchEnabled: true, logger: logger as never },
        {
          db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
        } as never
      );

      // The alternate model's query WAS issued, so it counts in annModelsQueried - but it threw and
      // served nothing, which is exactly the deployment state this alarm exists to report. Keying
      // the alarm off that metric would let a broken alternate index mask a scan-only primary.
      expect(result.scan.annModelsQueried).toBe(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(ALARM),
        expect.objectContaining({ reason: 'no-ready-files' })
      );
    });

    it('still fires when an alternate model queried successfully but returned zero hits', async () => {
      const ALT_MODEL = 'text-embedding-3-small';
      const logger = makeLogger();
      const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
        files: [
          annFile('primary-unstamped', { chunkEmbeddingModelStampedAt: undefined }),
          annFile('alt', { embeddingModel: ALT_MODEL }),
        ],
        scanChunks: chunkRows('primary-unstamped', 2),
        // Queryable index, successful query, no hits - the shape a lake takes when its chunk
        // labels are missing while FabFile.embeddingModel is populated. Nothing threw, so this is
        // NOT the failure case above.
        queryableModels: ['text-embedding-ada-002', ALT_MODEL],
      });

      const result = await semanticDataLakeSearch(
        { ...baseParams(), vectorSearchEnabled: true, logger: logger as never },
        {
          db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
        } as never
      );

      // `embedded && !failed` is true for this outcome, so keying the alarm on a query having
      // merely SUCCEEDED silences it in the exact production state it exists to catch: retrieval
      // is 100% scan and every result came from the scan path. Only "served a file" can gate it.
      expect(result.scan.annModelsQueried).toBe(1);
      expect(result.scan.annHits).toBe(0);
      expect(result.scan.chunksScanned).toBe(2);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(ALARM),
        // annModelsQueried in the payload is what tells an operator this was "ran and served
        // nothing" rather than "never ran" - the reason field only describes the primary model.
        expect.objectContaining({ reason: 'no-ready-files', annModelsQueried: 1, rankableFiles: 1 })
      );
    });

    it('reports index-not-queryable when the index migrator has not finished', async () => {
      const logger = makeLogger();
      const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
        files: [annFile('f1')],
        scanChunks: chunkRows('f1', 2),
        indexQueryable: false,
      });

      await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true, logger: logger as never }, {
        db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
      } as never);

      // Carried on EVERY arm, not just the no-ready-files one: an operator reading the alarm
      // should never have to know which arm fired to know whether the lag explains it.
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(ALARM),
        expect.objectContaining({ reason: 'index-not-queryable', rankableFiles: 1, stampedWithinLagFiles: 0 })
      );
    });

    it('reports no-backend when the flag is on but the deployment has no ANN backend', async () => {
      const logger = makeLogger();
      const { search, findVectorsByFabFileIds } = annAdapters({
        files: [annFile('f1')],
        scanChunks: chunkRows('f1', 2),
      });

      // No vectorSearch/getAtlasIndexStatus adapters and no vectorIndex: DocumentDB, or any
      // deployment where the flag was flipped on without the backend behind it.
      await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true, logger: logger as never }, {
        db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds } },
      } as never);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(ALARM),
        expect.objectContaining({
          reason: 'no-backend',
          backend: 'none',
          rankableFiles: 1,
          stampedWithinLagFiles: 0,
          annModelsQueried: 0,
        })
      );
    });

    it('stays silent on a healthy ANN query and when the caller never opted in', async () => {
      const healthyLogger = makeLogger();
      const healthy = annAdapters({
        files: [annFile('ready')],
        annHits: [{ id: 'ready-c0', fabFileId: 'ready', text: 'ann hit', score: 0.95 }],
      });
      await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true, logger: healthyLogger as never }, {
        db: {
          fabfiles: { search: healthy.search },
          fabfilechunks: {
            findVectorsByFabFileIds: healthy.findVectorsByFabFileIds,
            vectorSearch: healthy.vectorSearch,
            getAtlasIndexStatus: healthy.getAtlasIndexStatus,
          },
        },
      } as never);
      expect(healthyLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining(ALARM), expect.anything());

      // Flag off is the default for most deployments - scan-only is correct there, not an alarm.
      const offLogger = makeLogger();
      const off = annAdapters({ files: [annFile('f1')], scanChunks: chunkRows('f1', 2) });
      await semanticDataLakeSearch({ ...baseParams(), logger: offLogger as never }, {
        db: {
          fabfiles: { search: off.search },
          fabfilechunks: {
            findVectorsByFabFileIds: off.findVectorsByFabFileIds,
            vectorSearch: off.vectorSearch,
            getAtlasIndexStatus: off.getAtlasIndexStatus,
          },
        },
      } as never);
      expect(offLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining(ALARM), expect.anything());
    });
  });

  /**
   * The rebucket keys off SATURATION, not bare absence from `filesWithHits`.
   *
   * The ANN query is bounded by similarity rank (`limit: topK`), so at most topK files can appear
   * in `filesWithHits` and every other ready file is absent for the correct reason that it did not
   * rank. Rebucketing on absence alone made the ANN path's benefit `topK / fileCount`, shrinking
   * as a lake grows - backwards from the point of the index. These two tests pin the boundary in
   * both directions; the pair matters more than either alone, since a fix that simply stopped
   * rebucketing would pass the first and lose the un-indexed-file safety net the second guards.
   */
  it('does not rescan an unranked ready file when ANN saturated its limit', async () => {
    const logger = makeLogger();
    const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
      files: [annFile('covered'), annFile('unranked')],
      // Available to the scan if anything asked for them - the assertion is that nothing does.
      scanChunks: chunkRows('unranked', 3),
      annHits: [
        { id: 'covered-c0', fabFileId: 'covered', text: 'ann hit', score: 0.95 },
        { id: 'covered-c1', fabFileId: 'covered', text: 'ann hit', score: 0.94 },
      ],
    });

    const result = await semanticDataLakeSearch(
      { ...baseParams(), vectorSearchEnabled: true, topK: 2, logger: logger as never },
      {
        db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
      } as never
    );

    // The point of the index: a ready file that lost on rank costs nothing.
    expect(result.scan.chunksScanned).toBe(0);
    expect(findVectorsByFabFileIds).not.toHaveBeenCalled();
    // Both ready files stayed on the ANN route, so neither was scanned.
    expect(result.scan.annFilesQueried).toBe(2);
    expect(result.scan.annHits).toBe(2);
    expect(result.results.map(r => r.fileId)).toEqual(['covered', 'covered']);
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('returned no hits for ready files'),
      expect.anything()
    );
    // The failure this replaced was silent, so the scanning it avoided is recorded rather than
    // merely not happening - a regression back to rescanning would otherwise look identical.
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('saturated its limit'),
      expect.objectContaining({ fileCount: 1, hitsReturned: 2 })
    );
  });

  it('still rescans an unranked ready file when ANN came back short of its limit', async () => {
    const logger = makeLogger();
    const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
      files: [annFile('covered'), annFile('unranked')],
      scanChunks: chunkRows('unranked', 3),
      // One hit against topK 2: the backend exhausted what it has indexed and still came up short,
      // so absence is real evidence of missing content rather than a ranking outcome.
      annHits: [{ id: 'covered-c0', fabFileId: 'covered', text: 'ann hit', score: 0.95 }],
    });

    const result = await semanticDataLakeSearch(
      { ...baseParams(), vectorSearchEnabled: true, topK: 2, logger: logger as never },
      {
        db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
      } as never
    );

    expect(result.scan.chunksScanned).toBe(3);
    expect(result.scan.annFilesQueried).toBe(1);
    expect(result.results.map(r => r.fileId)).toContain('unranked');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('returned no hits for ready files'),
      expect.objectContaining({ fileCount: 1, hitsReturned: 1, hitsUsable: 1, limit: 2 })
    );
  });

  it('does not read a full response as saturated when every hit was out of scope', async () => {
    const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
      files: [annFile('ready')],
      scanChunks: chunkRows('ready', 3),
      // A full topK of hits whose parent file is not in this query's scope at all - a deleted
      // parent, or index content belonging to another lake. Counting them as saturation would
      // suppress the rescue and return NOTHING, where the scan would have answered: worse than the
      // behavior this PR replaced, which rescanned unconditionally.
      annHits: [
        { id: 'ghost-c0', fabFileId: 'not-in-scope', text: 'orphan hit', score: 0.99 },
        { id: 'ghost-c1', fabFileId: 'not-in-scope', text: 'orphan hit', score: 0.98 },
      ],
    });

    const result = await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true, topK: 2 }, {
      db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
    } as never);

    expect(result.scan.chunksScanned).toBe(3);
    expect(result.results.map(r => r.fileId)).toEqual(['ready', 'ready']);
  });

  it('subtracts out-of-scope hits in the MIXED shape, where they are what pushes the count to the limit', async () => {
    const logger = makeLogger();
    const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
      files: [annFile('ready'), annFile('other')],
      scanChunks: chunkRows('other', 3),
      // 3 raw hits against topK 3 reads as saturated on the raw count alone, but one belongs to a
      // file outside this query's scope, so only 2 are usable: the backend came up SHORT of what
      // it could rank, which is what makes `other`'s absence real evidence rather than a rank
      // outcome. The all-out-of-scope case above cannot distinguish this from an empty response.
      annHits: [
        { id: 'ready-c0', fabFileId: 'ready', text: 'ann hit', score: 0.95 },
        { id: 'ready-c1', fabFileId: 'ready', text: 'ann hit', score: 0.94 },
        { id: 'ghost-c0', fabFileId: 'not-in-scope', text: 'orphan hit', score: 0.99 },
      ],
    });

    const result = await semanticDataLakeSearch(
      { ...baseParams(), vectorSearchEnabled: true, topK: 3, logger: logger as never },
      {
        db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
      } as never
    );

    expect(result.scan.chunksScanned).toBe(3);
    expect(result.results.map(r => r.fileId)).toContain('other');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('returned no hits for ready files'),
      expect.objectContaining({ fileCount: 1, hitsReturned: 3, hitsUsable: 2, limit: 3 })
    );
  });

  it('stays quiet about saturation when every ready file actually ranked - nothing was left off', async () => {
    const logger = makeLogger();
    const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
      files: [annFile('a'), annFile('b')],
      annHits: [
        { id: 'a-c0', fabFileId: 'a', text: 'ann hit', score: 0.95 },
        { id: 'b-c0', fabFileId: 'b', text: 'ann hit', score: 0.94 },
      ],
    });

    const result = await semanticDataLakeSearch(
      { ...baseParams(), vectorSearchEnabled: true, topK: 2, logger: logger as never },
      {
        db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
      } as never
    );

    expect(result.scan.chunksScanned).toBe(0);
    expect(result.scan.annFilesQueried).toBe(2);
    // The debug line reports scanning the index AVOIDED, so a saturated query that left nothing
    // off must not emit it - otherwise a healthy lake logs a zero on every request.
    expect(logger.debug).not.toHaveBeenCalledWith(expect.stringContaining('saturated its limit'), expect.anything());
  });

  describe('mixed-embeddingModel lake (alternate-model ANN cutover)', () => {
    const SMALL_3 = 'text-embedding-3-small';
    const VOYAGE_3 = 'voyage-3';

    it('single-model lake calls vectorSearch, getAtlasIndexStatus, and the embed factory exactly once', async () => {
      const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
        files: [annFile('ready')],
        annHits: [{ id: 'ready-c0', fabFileId: 'ready', text: 'ann hit', score: 0.95 }],
      });

      await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true }, {
        db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
      } as never);

      expect(vectorSearch).toHaveBeenCalledTimes(1);
      expect(getAtlasIndexStatus).toHaveBeenCalledTimes(1);
      expect(mockCreateEmbeddingService).toHaveBeenCalledTimes(1);
    });

    it('serves both models of a mixed-model lake via their own ANN query and merges the results', async () => {
      const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
        files: [annFile('primary-hit'), annFile('alt-hit', { embeddingModel: SMALL_3 })],
        annHitsByModel: {
          'text-embedding-ada-002': [{ id: 'p-c0', fabFileId: 'primary-hit', text: 'primary hit', score: 0.9 }],
          [SMALL_3]: [{ id: 'a-c0', fabFileId: 'alt-hit', text: 'alt hit', score: 0.9 }],
        },
        queryableModels: ['text-embedding-ada-002', SMALL_3],
      });

      const result = await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true }, {
        db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
      } as never);

      expect(vectorSearch).toHaveBeenCalledTimes(2);
      expect(vectorSearch).toHaveBeenCalledWith(['primary-hit'], expect.anything(), 'text-embedding-ada-002', {
        limit: expect.any(Number),
      });
      expect(vectorSearch).toHaveBeenCalledWith(['alt-hit'], expect.anything(), SMALL_3, { limit: expect.any(Number) });
      // Each model embedded with its OWN vector - the mocked factory encodes model name length.
      expect(mockCreateEmbeddingService).toHaveBeenCalledWith('text-embedding-ada-002');
      expect(mockCreateEmbeddingService).toHaveBeenCalledWith(SMALL_3);
      expect(result.results.map(r => r.fileId).sort()).toEqual(['alt-hit', 'primary-hit']);
      expect(result.embeddingMismatch.excludedFiles.count).toBe(0);
      expect(result.embeddingMismatch.alternateModelServed).toEqual({ files: 1, models: [SMALL_3] });
      expect(result.alternateModelsEmbedded).toEqual([SMALL_3]);
      expect(result.scan.annModelsQueried).toBe(2);
      // The alternate model's file is served entirely via its own ANN index, never the scan path.
      expect(findVectorsByFabFileIds).not.toHaveBeenCalled();
    });

    it('excludes an alternate model with no queryable index, naming it in excludedFiles.models', async () => {
      const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
        files: [annFile('primary'), annFile('alt', { embeddingModel: SMALL_3, vectorizedChunkCount: 3 })],
        annHits: [{ id: 'p-c0', fabFileId: 'primary', text: 'hit', score: 0.9 }],
        queryableModels: ['text-embedding-ada-002'], // SMALL_3 not queryable
      });

      const result = await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true }, {
        db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
      } as never);

      expect(vectorSearch).toHaveBeenCalledTimes(1); // primary only
      expect(result.embeddingMismatch.excludedFiles.count).toBe(1);
      expect(result.embeddingMismatch.excludedFiles.models).toEqual([SMALL_3]);
      expect(result.embeddingMismatch.alternateModelServed).toEqual({ files: 0, models: [] });
    });

    it('excludes a freshly-stamped alternate-model file without scanning it', async () => {
      const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
        files: [
          annFile('primary'),
          annFile('alt-fresh', { embeddingModel: SMALL_3, chunkEmbeddingModelStampedAt: freshStamp }),
        ],
        annHits: [{ id: 'p-c0', fabFileId: 'primary', text: 'hit', score: 0.9 }],
        queryableModels: ['text-embedding-ada-002', SMALL_3],
      });

      const result = await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true }, {
        db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
      } as never);

      expect(vectorSearch).toHaveBeenCalledTimes(1); // primary only - alt file not yet ANN-ready
      expect(findVectorsByFabFileIds).not.toHaveBeenCalled(); // and never scanned either
      expect(result.embeddingMismatch.excludedFiles.models).toEqual([SMALL_3]);
    });

    it('an alternate vectorSearch throw still returns the primary results and does not reject', async () => {
      const logger = makeLogger();
      const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
        files: [annFile('primary'), annFile('alt', { embeddingModel: SMALL_3 })],
        annHitsByModel: { 'text-embedding-ada-002': [{ id: 'p-c0', fabFileId: 'primary', text: 'hit', score: 0.9 }] },
        queryableModels: ['text-embedding-ada-002', SMALL_3],
      });
      vectorSearch.mockImplementation((_ids: string[], _vec: number[], model: string) =>
        model === SMALL_3
          ? Promise.reject(new Error('alt index down'))
          : Promise.resolve([{ id: 'p-c0', fabFileId: 'primary', text: 'hit', score: 0.9 }])
      );

      const result = await semanticDataLakeSearch(
        { ...baseParams(), vectorSearchEnabled: true, logger: logger as never },
        {
          db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
        } as never
      );

      expect(result.results.map(r => r.fileId)).toEqual(['primary']);
      expect(result.embeddingMismatch.excludedFiles.models).toEqual([SMALL_3]);
      expect(logger.warn).toHaveBeenCalledWith(
        '[semanticSearch] alternate-model ANN query failed',
        expect.objectContaining({ model: SMALL_3 })
      );
      // The embed itself succeeded (only the ANN query threw), so it's still billable - this is
      // the ticket's "bill every model actually embedded, regardless of whether its query then
      // found anything" requirement, and the branch most likely to regress silently.
      expect(result.alternateModelsEmbedded).toEqual([SMALL_3]);
    });

    it('skips the alternate phase ENTIRELY when the primary ANN just failed, spending no alternate embeds against the same broken backend', async () => {
      const logger = makeLogger();
      const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
        files: [annFile('primary'), annFile('alt', { embeddingModel: SMALL_3 })],
        scanChunks: chunkRows('primary', 1),
        queryableModels: ['text-embedding-ada-002', SMALL_3],
      });
      vectorSearch.mockImplementation((_ids: string[], _vec: number[], model: string) =>
        model === 'text-embedding-ada-002' ? Promise.reject(new Error('backend outage')) : Promise.resolve([])
      );

      const result = await semanticDataLakeSearch(
        { ...baseParams(), vectorSearchEnabled: true, logger: logger as never },
        {
          db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
        } as never
      );

      // Only the PRIMARY model's vectorSearch was ever called - the alternate never got its own
      // embed or query attempt.
      expect(vectorSearch).toHaveBeenCalledTimes(1);
      expect(mockCreateEmbeddingService).toHaveBeenCalledTimes(1);
      expect(result.alternateModelsEmbedded).toEqual([]);
      expect(result.embeddingMismatch.excludedFiles.models).toEqual([SMALL_3]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('skipping the alternate-model phase'),
        expect.anything()
      );
    });

    it('excludes an alternate model with no credential in the key table, without attempting to embed it', async () => {
      const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
        files: [annFile('primary'), annFile('alt-voyage', { embeddingModel: VOYAGE_3, vectorizedChunkCount: 1 })],
        annHits: [{ id: 'p-c0', fabFileId: 'primary', text: 'hit', score: 0.9 }],
        queryableModels: ['text-embedding-ada-002', VOYAGE_3],
      });

      const result = await semanticDataLakeSearch(
        { ...baseParams(), apiKeyTable: { openai: 'k' }, vectorSearchEnabled: true }, // no voyageai key
        {
          db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
        } as never
      );

      expect(vectorSearch).toHaveBeenCalledTimes(1); // primary only - never attempted for voyage-3
      expect(mockCreateEmbeddingService).not.toHaveBeenCalledWith(VOYAGE_3);
      expect(result.embeddingMismatch.excludedFiles.models).toEqual([VOYAGE_3]);
    });

    it('caps at MAX_ALTERNATE_ANN_MODELS extra vectorSearch calls when more distinct models are present', async () => {
      const models = [SMALL_3, VOYAGE_3, 'text-embedding-3-large', 'amazon.titan-embed-text-v2:0'];
      const files = [
        annFile('primary'),
        ...models.map((m, i) => annFile(`alt-${i}`, { embeddingModel: m, vectorizedChunkCount: 1 })),
      ];
      const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
        files,
        annHits: [{ id: 'p-c0', fabFileId: 'primary', text: 'hit', score: 0.9 }],
        queryableModels: ['text-embedding-ada-002', ...models],
      });

      await semanticDataLakeSearch(
        { ...baseParams(), apiKeyTable: { openai: 'k', voyageai: 'k2' }, vectorSearchEnabled: true },
        {
          db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
        } as never
      );

      // 1 primary + at most 3 alternates (MAX_ALTERNATE_ANN_MODELS), regardless of 4 being eligible.
      expect(vectorSearch).toHaveBeenCalledTimes(4);
    });

    it('a higher-scoring alternate hit outranks a primary hit (documented raw-cosine cross-model bias)', async () => {
      const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
        files: [annFile('primary'), annFile('alt', { embeddingModel: SMALL_3 })],
        annHitsByModel: {
          'text-embedding-ada-002': [{ id: 'p-c0', fabFileId: 'primary', text: 'primary hit', score: 0.5 }],
          [SMALL_3]: [{ id: 'a-c0', fabFileId: 'alt', text: 'alt hit', score: 0.95 }],
        },
        queryableModels: ['text-embedding-ada-002', SMALL_3],
      });

      const result = await semanticDataLakeSearch({ ...baseParams(), topK: 1, vectorSearchEnabled: true }, {
        db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
      } as never);

      // topK: 1 forces the merge to pick a single winner - the higher raw-cosine alternate hit wins,
      // even though cross-model scores are not truly comparable. This is the accepted tradeoff.
      expect(result.results).toHaveLength(1);
      expect(result.results[0].fileId).toBe('alt');
    });

    it('does not warn "nothing could be compared" when only an alternate model returned hits', async () => {
      const logger = makeLogger();
      const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
        files: [annFile('alt', { embeddingModel: SMALL_3 })],
        annHitsByModel: { [SMALL_3]: [{ id: 'a-c0', fabFileId: 'alt', text: 'alt hit', score: 0.9 }] },
        queryableModels: ['text-embedding-ada-002', SMALL_3],
      });

      await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true, logger: logger as never }, {
        db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
      } as never);

      expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('nothing could be compared'));
    });

    it('never queries the primary model twice', async () => {
      const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
        files: [annFile('primary'), annFile('alt', { embeddingModel: SMALL_3 })],
        annHits: [{ id: 'p-c0', fabFileId: 'primary', text: 'hit', score: 0.9 }],
        queryableModels: ['text-embedding-ada-002', SMALL_3],
      });

      await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true }, {
        db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
      } as never);

      const primaryCalls = vectorSearch.mock.calls.filter(c => c[2] === 'text-embedding-ada-002');
      expect(primaryCalls).toHaveLength(1);
    });

    it('kill switch off: a 3-distinct-model lake makes zero extra embeds/probes and matches today byte-for-byte', async () => {
      const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
        files: [
          annFile('primary'),
          annFile('alt1', { embeddingModel: SMALL_3, vectorizedChunkCount: 1 }),
          annFile('alt2', { embeddingModel: VOYAGE_3, vectorizedChunkCount: 1 }),
        ],
        scanChunks: chunkRows('primary', 1),
        queryableModels: ['text-embedding-ada-002', SMALL_3, VOYAGE_3],
      });

      // vectorSearchEnabled omitted (defaults false) - the kill switch.
      const result = await semanticDataLakeSearch(baseParams(), {
        db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
      } as never);

      expect(vectorSearch).not.toHaveBeenCalled();
      expect(getAtlasIndexStatus).not.toHaveBeenCalled();
      expect(mockCreateEmbeddingService).toHaveBeenCalledTimes(1); // primary query embed only
      expect(result.embeddingMismatch.excludedFiles.count).toBe(2);
      expect(result.embeddingMismatch.excludedFiles.models).toEqual([SMALL_3, VOYAGE_3]);
      expect(result.embeddingMismatch.alternateModelServed).toEqual({ files: 0, models: [] });
    });

    it('reports partial coverage within one alternate model: served files are not double-counted as excluded', async () => {
      // The alternate model's own ANN query finds hits for only 2 of its 3 ready files - the
      // served/excluded split must be computed PER FILE, not per model.
      const { search, findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } = annAdapters({
        files: [
          annFile('primary'),
          annFile('alt-hit-1', { embeddingModel: SMALL_3 }),
          annFile('alt-hit-2', { embeddingModel: SMALL_3 }),
          annFile('alt-miss', { embeddingModel: SMALL_3 }),
        ],
        annHitsByModel: {
          'text-embedding-ada-002': [{ id: 'p-c0', fabFileId: 'primary', text: 'hit', score: 0.9 }],
          [SMALL_3]: [
            { id: 'a1-c0', fabFileId: 'alt-hit-1', text: 'alt hit 1', score: 0.9 },
            { id: 'a2-c0', fabFileId: 'alt-hit-2', text: 'alt hit 2', score: 0.9 },
          ],
        },
        queryableModels: ['text-embedding-ada-002', SMALL_3],
      });

      const result = await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true }, {
        db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus } },
      } as never);

      expect(result.results.map(r => r.fileId).sort()).toEqual(['alt-hit-1', 'alt-hit-2', 'primary']);
      // alt-miss stays excluded (SMALL_3 is still a genuinely-foreign model for it), but the two
      // served files are NOT in excludedFiles - the model still appears there because one of its
      // files is still uncovered.
      expect(result.embeddingMismatch.excludedFiles.count).toBe(1);
      expect(result.embeddingMismatch.excludedFiles.sample.map(f => f.fileId)).toEqual(['alt-miss']);
      expect(result.embeddingMismatch.excludedFiles.models).toEqual([SMALL_3]);
      expect(result.embeddingMismatch.alternateModelServed).toEqual({ files: 2, models: [SMALL_3] });
      // alt-miss never reaches the scan path either - the ticket's explicit scope boundary.
      expect(findVectorsByFabFileIds).not.toHaveBeenCalled();
    });
  });
});

describe('semanticDataLakeSearch self-host OpenSearch cutover', () => {
  const readyStamp = new Date(Date.now() - 120_000);
  const originalEnv = { ...process.env };

  const enableSelfHostOpenSearch = () => {
    process.env.B4M_SELF_HOST = 'true';
    process.env.B4M_SELF_HOST_OPENSEARCH = 'true';
    process.env.OPENSEARCH_ENDPOINT = 'localhost:9200';
  };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const annFile = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    fileName: `${id}.pdf`,
    tags: [],
    embeddingModel: 'text-embedding-ada-002',
    vectorizedChunkCount: 1,
    chunkEmbeddingModelStampedAt: readyStamp,
    ...overrides,
  });

  const PRIMARY_MODEL = 'text-embedding-ada-002';

  /** Keyed on `model`, same reasoning as the Atlas harness's annAdapters above. */
  const openSearchAdapters = (args: {
    files: ReturnType<typeof annFile>[];
    scanChunks?: { id: string; fabFileId: string; text: string; vector: number[] }[];
    annHits?: { id: string; fabFileId: string; text: string; score: number }[];
    annHitsByModel?: Record<string, { id: string; fabFileId: string; text: string; score: number }[]>;
  }) => {
    const findVectorsByFabFileIds = pagingChunkMock(args.scanChunks ?? []);
    const hitsByModel: Record<string, { id: string; fabFileId: string; text: string; score: number }[]> = {
      ...(args.annHitsByModel ?? {}),
    };
    if (args.annHits !== undefined) hitsByModel[PRIMARY_MODEL] = args.annHits;
    const knnSearch = vi.fn((_fileIds: string[], _vector: number[], model: string) =>
      Promise.resolve(hitsByModel[model] ?? [])
    );
    return {
      search: filesAdapter([{ data: args.files, hasMore: false, total: args.files.length }]),
      findVectorsByFabFileIds,
      knnSearch,
    };
  };

  it('never calls knnSearch when self-host OpenSearch is disabled (default env)', async () => {
    const { search, findVectorsByFabFileIds, knnSearch } = openSearchAdapters({
      files: [annFile('f1')],
      scanChunks: chunkRows('f1', 2),
    });

    const result = await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true }, {
      db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds } },
      vectorIndex: { knnSearch },
    } as never);

    expect(knnSearch).not.toHaveBeenCalled();
    expect(result.scan.annFilesQueried).toBe(0);
    expect(result.scan.chunksScanned).toBe(2);
  });

  it('routes a ready file to OpenSearch when the flag and endpoint are set', async () => {
    enableSelfHostOpenSearch();
    const { search, findVectorsByFabFileIds, knnSearch } = openSearchAdapters({
      files: [annFile('ready')],
      annHits: [{ id: 'ready-c0', fabFileId: 'ready', text: 'ann hit', score: 0.95 }],
    });

    const result = await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true }, {
      db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds } },
      vectorIndex: { knnSearch },
    } as never);

    expect(knnSearch).toHaveBeenCalledWith(['ready'], expect.anything(), 'text-embedding-ada-002', {
      limit: expect.any(Number),
    });
    expect(result.scan.annFilesQueried).toBe(1);
    expect(result.scan.annHits).toBe(1);
  });

  it('never calls knnSearch when the vectorIndex adapter is not provided, even with the flag on', async () => {
    enableSelfHostOpenSearch();
    const { search, findVectorsByFabFileIds } = openSearchAdapters({
      files: [annFile('f1')],
      scanChunks: chunkRows('f1', 1),
    });

    const result = await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true }, {
      db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds } },
    } as never);

    expect(result.scan.annFilesQueried).toBe(0);
    expect(result.scan.chunksScanned).toBe(1);
  });

  it('fails open to scan when knnSearch throws', async () => {
    enableSelfHostOpenSearch();
    const logger = makeLogger();
    const { search, findVectorsByFabFileIds, knnSearch } = openSearchAdapters({
      files: [annFile('ready')],
      scanChunks: chunkRows('ready', 2),
    });
    knnSearch.mockRejectedValueOnce(new Error('cluster unreachable'));

    const result = await semanticDataLakeSearch(
      { ...baseParams(), vectorSearchEnabled: true, logger: logger as never },
      {
        db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds } },
        vectorIndex: { knnSearch },
      } as never
    );

    expect(result.scan.annFilesQueried).toBe(0);
    expect(result.scan.chunksScanned).toBe(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ANN vector search failed'),
      expect.objectContaining({ backend: 'opensearch' })
    );
  });

  it('rebuckets a ready file onto scan when knnSearch returns zero hits (not yet dual-written)', async () => {
    enableSelfHostOpenSearch();
    const { search, findVectorsByFabFileIds, knnSearch } = openSearchAdapters({
      files: [annFile('ready')],
      scanChunks: chunkRows('ready', 2),
      annHits: [],
    });

    const result = await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true }, {
      db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds } },
      vectorIndex: { knnSearch },
    } as never);

    expect(result.scan.annFilesQueried).toBe(0);
    expect(result.scan.chunksScanned).toBe(2);
    expect(result.results.map(r => r.fileId)).toEqual(['ready', 'ready']);
  });

  /**
   * The Atlas saturation rule deliberately does NOT apply here.
   *
   * Atlas's argument for it is that mongot indexes the chunk collection itself, so a stamped file's
   * content is in the index by construction. Self-host has no such guarantee: the documents live in
   * a separate cluster fed by a fail-open dual-write, files predating the feature were never indexed
   * and have no backfill, and the readiness stamp knows nothing about any of it. Absence-keyed
   * rescue is the only thing covering that here, so it stays - at the cost of the topK/fileCount
   * ceiling on this path. Without a saturating fixture the existing zero-hit test above cannot see
   * the difference, which is why this one supplies a full topK of hits from the indexed file.
   */
  it('rescans a stamped-but-unindexed file even when knnSearch saturated its limit', async () => {
    enableSelfHostOpenSearch();
    const { search, findVectorsByFabFileIds, knnSearch } = openSearchAdapters({
      files: [annFile('indexed'), annFile('never-dual-written')],
      scanChunks: chunkRows('never-dual-written', 3),
      annHits: [
        { id: 'indexed-c0', fabFileId: 'indexed', text: 'ann hit', score: 0.95 },
        { id: 'indexed-c1', fabFileId: 'indexed', text: 'ann hit', score: 0.94 },
      ],
    });

    const result = await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true, topK: 2 }, {
      db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds } },
      vectorIndex: { knnSearch },
    } as never);

    expect(result.scan.chunksScanned).toBe(3);
    expect(result.scan.annFilesQueried).toBe(1);
    expect(result.results.map(r => r.fileId)).toContain('never-dual-written');
  });

  it('never calls knnSearch on an Atlas-backed deployment even if a vectorIndex adapter is (mistakenly) provided', async () => {
    // Atlas is the default backend with no env vars set - this asserts the if/else-if mutual
    // exclusion, not just "self-host off".
    const { search, findVectorsByFabFileIds, knnSearch } = openSearchAdapters({
      files: [annFile('f1')],
      scanChunks: chunkRows('f1', 1),
    });

    await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true }, {
      db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds } },
      vectorIndex: { knnSearch },
    } as never);

    expect(knnSearch).not.toHaveBeenCalled();
  });

  describe('mixed-embeddingModel lake (alternate-model ANN cutover)', () => {
    const SMALL_3 = 'text-embedding-3-small';

    it('issues one knnSearch per distinct model, proving the seam is shared, not Atlas-special', async () => {
      enableSelfHostOpenSearch();
      const { search, findVectorsByFabFileIds, knnSearch } = openSearchAdapters({
        files: [annFile('primary'), annFile('alt', { embeddingModel: SMALL_3 })],
        annHitsByModel: {
          'text-embedding-ada-002': [{ id: 'p-c0', fabFileId: 'primary', text: 'hit', score: 0.9 }],
          [SMALL_3]: [{ id: 'a-c0', fabFileId: 'alt', text: 'alt hit', score: 0.9 }],
        },
      });

      const result = await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true }, {
        db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds } },
        vectorIndex: { knnSearch },
      } as never);

      expect(knnSearch).toHaveBeenCalledTimes(2);
      expect(knnSearch).toHaveBeenCalledWith(['primary'], expect.anything(), 'text-embedding-ada-002', {
        limit: expect.any(Number),
      });
      expect(knnSearch).toHaveBeenCalledWith(['alt'], expect.anything(), SMALL_3, { limit: expect.any(Number) });
      expect(result.results.map(r => r.fileId).sort()).toEqual(['alt', 'primary']);
    });

    it('leaves an alternate model excluded (not scanned) when its knnSearch returns zero hits', async () => {
      enableSelfHostOpenSearch();
      const { search, findVectorsByFabFileIds, knnSearch } = openSearchAdapters({
        files: [annFile('primary'), annFile('alt', { embeddingModel: SMALL_3, vectorizedChunkCount: 1 })],
        annHits: [{ id: 'p-c0', fabFileId: 'primary', text: 'hit', score: 0.9 }],
        // alt's model gets no entry in annHitsByModel -> knnSearch resolves [] for it.
      });

      const result = await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true }, {
        db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds } },
        vectorIndex: { knnSearch },
      } as never);

      expect(findVectorsByFabFileIds).not.toHaveBeenCalled();
      expect(result.embeddingMismatch.excludedFiles.models).toEqual([SMALL_3]);
    });

    it('runs no alternate phase when self-host OpenSearch is disabled, even for a mixed-model lake', async () => {
      // Default env (no enableSelfHostOpenSearch() call) - canUseOpenSearch is false.
      const { search, findVectorsByFabFileIds, knnSearch } = openSearchAdapters({
        files: [annFile('primary'), annFile('alt', { embeddingModel: SMALL_3, vectorizedChunkCount: 1 })],
        scanChunks: chunkRows('primary', 1),
      });

      const result = await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true }, {
        db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds } },
        vectorIndex: { knnSearch },
      } as never);

      expect(knnSearch).not.toHaveBeenCalled();
      expect(result.embeddingMismatch.excludedFiles.models).toEqual([SMALL_3]);
    });

    it('runs no alternate phase when the vectorIndex adapter is absent, even with the flag on', async () => {
      enableSelfHostOpenSearch();
      const { search, findVectorsByFabFileIds } = openSearchAdapters({
        files: [annFile('primary'), annFile('alt', { embeddingModel: SMALL_3, vectorizedChunkCount: 1 })],
        scanChunks: chunkRows('primary', 1),
      });

      const result = await semanticDataLakeSearch({ ...baseParams(), vectorSearchEnabled: true }, {
        db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds } },
        // no vectorIndex passed
      } as never);

      expect(result.embeddingMismatch.excludedFiles.models).toEqual([SMALL_3]);
    });
  });
});

// #1681 constraint 1. A convergence rewrite deletes the member's chunk rows and reinserts rows
// carrying no vector, and the chunk read filters on vector presence - so the member contributes
// nothing and its OLD vectors are already gone. "Serve stale" is not available. It must be refused
// explicitly and the result set marked partial, or neighbouring chunks quietly fill the top-K and
// the model answers confidently from a corpus with a hole in it.
describe('semanticDataLakeSearch withholds mid-(re)index members (#1681)', () => {
  const withFiles = (files: Record<string, unknown>[], findVectors: ReturnType<typeof vi.fn>) => ({
    db: {
      fabfiles: { search: vi.fn().mockResolvedValue({ data: files, hasMore: false, total: files.length }) },
      fabfilechunks: { findVectorsByFabFileIds: findVectors },
    },
  });

  const converging = { id: 'converging', fileName: 'Big.pdf', tags: [], chunkCount: 12, vectorizedChunkCount: 0 };
  const settled = { id: 'settled', fileName: 'Clean.pdf', tags: [], chunkCount: 4, vectorizedChunkCount: 4 };

  it('never loads the converging member chunk vectors, and still ranks its neighbours', async () => {
    const findVectors = pagingChunkMock([
      { id: 'ch1', fabFileId: 'settled', vector: [1, 0], text: 'settled content' },
    ] as never);

    const result = await semanticDataLakeSearch(baseParams(), withFiles([converging, settled], findVectors) as never);

    expect(findVectors.mock.calls[0][0]).toEqual(['settled']);
    expect(result.results.map(r => r.fileId)).toEqual(['settled']);
  });

  it('marks the result set partial and names the withheld member', async () => {
    const result = await semanticDataLakeSearch(
      baseParams(),
      withFiles([converging, settled], pagingChunkMock([] as never)) as never
    );

    expect(result.retrievalUnavailable.partial).toBe(true);
    expect(result.retrievalUnavailable.indexing.count).toBe(1);
    expect(result.retrievalUnavailable.indexing.sample).toEqual([{ fileId: 'converging', fileName: 'Big.pdf' }]);
  });

  it('reports a fully-settled lake as complete', async () => {
    const result = await semanticDataLakeSearch(
      baseParams(),
      withFiles([settled], pagingChunkMock([] as never)) as never
    );

    expect(result.retrievalUnavailable.partial).toBe(false);
    expect(result.retrievalUnavailable.indexing.count).toBe(0);
  });

  // The refusal must reach the allow-list entrypoint too - a builder that forgets the index-state
  // fields silently re-arms the bug on that door alone.
  it('applies to the file-scoped entrypoint as well', async () => {
    const getAccessibleFiles = vi.fn().mockResolvedValue([converging]);
    const findVectorsByFabFileIds = pagingChunkMock([] as never);

    const result = await fileScopedSemanticSearch(
      {
        query: 'stage III treatment',
        fileIds: ['converging'],
        embeddingModel: 'text-embedding-ada-002' as SemanticDataLakeSearchParams['embeddingModel'],
        apiKeyTable: { openai: 'k' },
      },
      { db: { fabfiles: { getAccessibleFiles }, fabfilechunks: { findVectorsByFabFileIds } } } as never
    );

    expect(result.retrievalUnavailable.indexing.count).toBe(1);
    expect(findVectorsByFabFileIds).not.toHaveBeenCalled();
  });

  // #1939. The pending-rebuild stamp is the ONLY in-flight signal a chunkless member carries, so a
  // builder that drops it hands the partition a file that reads as an image and serves it silently.
  // Both entrypoints are asserted for the same reason the two above are - and this pair is not
  // theoretical: the field was carried into the ranking map but NOT into either `fileById` builder,
  // so `indexing.count` read 0 against a real local lake until that was fixed.
  const rebuilding = {
    id: 'rebuilding',
    fileName: 'Reset.pdf',
    tags: [],
    chunkCount: 0,
    vectorizedChunkCount: 0,
    notes: '',
    error: null,
    chunkRebuildRequestedAt: new Date('2026-08-20T00:00:00Z'),
  };

  it('withholds a member whose rebuild was requested but never committed', async () => {
    const result = await semanticDataLakeSearch(
      baseParams(),
      withFiles([rebuilding, settled], pagingChunkMock([] as never)) as never
    );

    expect(result.retrievalUnavailable.indexing.count).toBe(1);
    expect(result.retrievalUnavailable.indexing.sample).toEqual([{ fileId: 'rebuilding', fileName: 'Reset.pdf' }]);
    // Bucketed as re-indexing, never as paused: the prose for `paused` tells the reader an
    // administrator has to act, which is wrong for an ordinary rebuild.
    expect(result.retrievalUnavailable.paused.count).toBe(0);
  });

  it('serves the same member once the stamp is cleared, so the stamp is what decides', async () => {
    const result = await semanticDataLakeSearch(
      baseParams(),
      withFiles([{ ...rebuilding, chunkRebuildRequestedAt: null }, settled], pagingChunkMock([] as never)) as never
    );

    expect(result.retrievalUnavailable.partial).toBe(false);
  });

  it('applies the pending-rebuild withhold to the file-scoped entrypoint as well', async () => {
    const getAccessibleFiles = vi.fn().mockResolvedValue([rebuilding]);
    const findVectorsByFabFileIds = pagingChunkMock([] as never);

    const result = await fileScopedSemanticSearch(
      {
        query: 'stage III treatment',
        fileIds: ['rebuilding'],
        embeddingModel: 'text-embedding-ada-002' as SemanticDataLakeSearchParams['embeddingModel'],
        apiKeyTable: { openai: 'k' },
      },
      { db: { fabfiles: { getAccessibleFiles }, fabfilechunks: { findVectorsByFabFileIds } } } as never
    );

    expect(result.retrievalUnavailable.indexing.count).toBe(1);
    expect(result.retrievalUnavailable.paused.count).toBe(0);
  });
});

/**
 * `comparedNoPassages` is the seam that separates "we looked at none of the corpus" from "we
 * looked and it did not match" - the distinction `results.length` cannot make, and the one a
 * retrieval outcome is graded on (see proveRetrievalOutcome in knowledgeBaseSearch).
 *
 * Both routes have to count, and each was a plausible one-sided implementation: keying on the scan
 * count alone reports every healthy all-ANN deployment as unsearched, and keying on the ann hits
 * alone reports every DocumentDB/self-host deployment the same way.
 */
describe('comparedNoPassages', () => {
  const scanOf = (over: Partial<{ annHits: number }> = {}) => ({
    truncated: false,
    fileBudgetHit: false,
    chunkBudgetHit: false,
    filesMatching: 3,
    filesScoped: 3,
    filesScanned: 3,
    chunksScanned: 0,
    chunksSkippedDimensionMismatch: 0,
    annFilesQueried: 0,
    annHits: 0,
    annModelsQueried: 0,
    budgets: { maxFiles: 20000, maxChunks: 100000 },
    ...over,
  });

  it('is true only when neither route compared anything', () => {
    expect(comparedNoPassages({ chunksScored: 0, scan: scanOf() })).toBe(true);
  });

  it('is false once the scan path scored a chunk, even with no ann hits', () => {
    expect(comparedNoPassages({ chunksScored: 1, scan: scanOf() })).toBe(false);
  });

  it('is false once an ann index returned a hit, even with nothing scored on the scan path', () => {
    expect(comparedNoPassages({ chunksScored: 0, scan: scanOf({ annHits: 1 }) })).toBe(false);
  });
});

/**
 * ANN/scan ranking parity.
 *
 * The cutover suite above proves the two partitions MERGE (a ready file goes to Atlas, a fresh one
 * stays on scan, both land in one ranking), but its ann branch returns a hardcoded score, so
 * nothing there can see the two paths disagree about ORDER or SCALE. That gap matters because the
 * paths compute their scores differently: the scan path runs `computeCosineSimilarity` directly,
 * while the ann path denormalizes the backend's [0,1] score back to raw cosine (`2 * score - 1`,
 * see annVectorSearch.ts) precisely so the two are comparable inside one `BoundedTopK`. If that
 * conversion, the comparator, or the merge regressed, every existing test would still pass and
 * retrieval would silently reorder.
 *
 * Method: one fixed corpus, scored two ways. The ann adapter here is EXHAUSTIVE - it ranks the
 * same vectors by true cosine and returns the top `limit` - so any difference in output is the
 * plumbing, not the backend. That is deliberate and also the limit of what a unit test can pin:
 * it does NOT model Atlas's approximate recall (`numCandidates`, FabFileModel.ts), which is the
 * one case where ann can legitimately return less than the scan would.
 */
describe('semanticDataLakeSearch ANN/scan ranking parity', () => {
  const PARITY_MODEL = 'text-embedding-ada-002';
  const readyStamp = new Date(Date.now() - 120_000); // past the 60s mongot indexing lag

  const realCosine = (a: number[], b: number[]): number => {
    const dot = a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);
    const magA = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
    const magB = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
    return magA === 0 || magB === 0 ? 0 : dot / (magA * magB);
  };

  /**
   * Chunks alternate between two files so the top-K spans both: a corpus where the best K all sit
   * in one file would pass even if the merge dropped a whole partition. Angles increase with the
   * index, so cosine against the query direction is strictly decreasing and the expected order is
   * unambiguous (no ties for the comparator's tie-break to decide).
   */
  const CORPUS = Array.from({ length: 8 }, (_, i) => {
    const theta = ((i + 1) * 5 * Math.PI) / 180;
    return {
      id: `c${String(i).padStart(2, '0')}`,
      fabFileId: i % 2 === 0 ? 'fileA' : 'fileB',
      text: `passage ${i}`,
      vector: [Math.cos(theta), Math.sin(theta)],
    };
  });

  const parityFile = (id: string) => ({
    id,
    fileName: `${id}.pdf`,
    tags: [],
    embeddingModel: PARITY_MODEL,
    vectorizedChunkCount: 4,
    chunkEmbeddingModelStampedAt: readyStamp,
  });

  const TOP_K = 4;

  const runSearch = async (vectorSearchEnabled: boolean) => {
    const files = [parityFile('fileA'), parityFile('fileB')];

    // Scan sees the whole corpus; with ann enabled both files are ann-eligible, so the scan
    // partition is empty and this mock is simply never asked for them.
    const findVectorsByFabFileIds = pagingChunkMock(CORPUS);

    // Exhaustive stand-in for $vectorSearch: true cosine over the same vectors, ranked, truncated
    // to `limit`, and re-normalized to the [0,1] scale Atlas reports so the production
    // `2 * score - 1` recovers the raw cosine.
    const vectorSearch = vi.fn((fileIds: string[], vector: number[], model: string, opts?: { limit?: number }) => {
      if (model !== PARITY_MODEL) return Promise.resolve([]);
      return Promise.resolve(
        CORPUS.filter(c => fileIds.includes(c.fabFileId))
          .map(c => ({ id: c.id, fabFileId: c.fabFileId, text: c.text, score: (realCosine(vector, c.vector) + 1) / 2 }))
          .sort((a, b) => b.score - a.score)
          .slice(0, opts?.limit ?? CORPUS.length)
      );
    });

    const getAtlasIndexStatus = vi.fn((model: string) =>
      Promise.resolve({ queryable: model === PARITY_MODEL, status: 'READY' })
    );

    return semanticDataLakeSearch(
      {
        ...baseParams(),
        embeddingModel: PARITY_MODEL as SemanticDataLakeSearchParams['embeddingModel'],
        topK: TOP_K,
        vectorSearchEnabled,
      },
      {
        db: {
          fabfiles: { search: filesAdapter([{ data: files, hasMore: false, total: files.length }]) },
          fabfilechunks: { findVectorsByFabFileIds, vectorSearch, getAtlasIndexStatus },
        },
      } as never
    );
  };

  beforeEach(() => {
    // The suite-wide cosine mock returns a flat 0.9, which would make every chunk tie and destroy
    // the ordering this block exists to compare. Restored to the real computation here only.
    mockCosine.mockImplementation((a: number[], b: number[]) => realCosine(a, b));
  });

  it('ranks identically whether the scan or an exhaustive ANN produced the results', async () => {
    const viaScan = await runSearch(false);
    const viaAnn = await runSearch(true);

    // Guard against a vacuous pass: if ann never engaged, both runs are the scan path and the
    // comparison below is trivially true.
    expect(viaScan.scan.annModelsQueried).toBe(0);
    expect(viaAnn.scan.annModelsQueried).toBeGreaterThan(0);

    expect(viaAnn.results).toHaveLength(TOP_K);
    expect(viaAnn.results.map(r => r.chunkId)).toEqual(viaScan.results.map(r => r.chunkId));
    expect(viaAnn.results.map(r => r.fileId)).toEqual(viaScan.results.map(r => r.fileId));

    viaAnn.results.forEach((hit, i) => {
      expect(hit.score).toBeCloseTo(viaScan.results[i].score, 9);
    });
  });

  it('selects the same top-K across both files rather than draining one partition', async () => {
    const viaAnn = await runSearch(true);

    // The corpus alternates files by index and cosine decreases with index, so the first four are
    // c00..c03 spanning both files. A merge that concatenated partitions instead of ranking across
    // them would return four chunks from one file.
    expect(viaAnn.results.map(r => r.chunkId)).toEqual(['c00', 'c01', 'c02', 'c03']);
    expect(new Set(viaAnn.results.map(r => r.fileId))).toEqual(new Set(['fileA', 'fileB']));
  });

  it('recovers raw cosine from the backend score rather than passing the normalized value through', async () => {
    const viaAnn = await runSearch(true);

    // cos(5 degrees) for the top hit. A missing denormalization would report (cos + 1) / 2, about
    // 0.998, which is close enough to the true 0.996 to survive a loose assertion - hence the
    // tight tolerance.
    expect(viaAnn.results[0].score).toBeCloseTo(Math.cos((5 * Math.PI) / 180), 6);
  });
});
