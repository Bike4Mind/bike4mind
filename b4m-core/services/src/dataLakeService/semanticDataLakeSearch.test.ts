import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Cosine is a hoisted mock so individual tests can vary scores; the default keeps every chunk
// above the floor, which is what the pre-existing exclusion/scoping tests assume.
// mockCreateEmbeddingService is a spy (not just a stub) so multi-model tests can assert exactly
// which models were embedded and how many times.
const { mockCosine, mockCreateEmbeddingService } = vi.hoisted(() => ({
  mockCosine: vi.fn(() => 0.9),
  mockCreateEmbeddingService: vi.fn(),
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
        return { generateEmbedding: async () => [model.length, 0] };
      }
    },
  };
});

import {
  fileScopedSemanticSearch,
  semanticDataLakeSearch,
  type SemanticDataLakeSearchParams,
} from './semanticDataLakeSearch';

beforeEach(() => {
  mockCosine.mockReset();
  mockCosine.mockReturnValue(0.9);
  mockCreateEmbeddingService.mockClear();
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

  it('asks for the _id sort tiebreaker, without which a multi-page walk can lose a file', async () => {
    const search = filesAdapter([{ data: oneFile, hasMore: false, total: 1 }]);
    await semanticDataLakeSearch(baseParams(), {
      db: { fabfiles: { search }, fabfilechunks: { findVectorsByFabFileIds: pagingChunkMock([]) } },
    } as never);

    expect(search.mock.calls[0][5]).toMatchObject({ stableSort: true });
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
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('TRUNCATED'));
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
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('TRUNCATED'));
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
