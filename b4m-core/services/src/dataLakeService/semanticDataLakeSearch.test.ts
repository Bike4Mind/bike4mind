import { describe, it, expect, vi, beforeEach } from 'vitest';

// Cosine is a hoisted mock so individual tests can vary scores; the default keeps every chunk
// above the floor, which is what the pre-existing exclusion/scoping tests assume.
const { mockCosine } = vi.hoisted(() => ({ mockCosine: vi.fn(() => 0.9) }));

// Mock only the embedding/provider helpers from the utils barrel; keep the real
// `@bike4mind/utils/retrievalExclusion` subpath so filterRetrievalExcluded runs for real.
vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    getProviderFromModel: () => 'openai',
    computeCosineSimilarity: mockCosine,
    EmbeddingFactory: class {
      createEmbeddingService() {
        return { generateEmbedding: async () => [1, 0] };
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
});
