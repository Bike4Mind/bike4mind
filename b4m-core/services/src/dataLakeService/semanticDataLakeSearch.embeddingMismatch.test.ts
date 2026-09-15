import { describe, it, expect, vi, beforeEach } from 'vitest';

// The sibling suite mocks computeCosineSimilarity away, so it cannot prove any of the ranking
// behavior below. Here only the provider/embedding plumbing is mocked and the REAL cosine runs,
// which is the whole point: the headline case turns on two vectors of IDENTICAL width.
const h = vi.hoisted(() => ({ queryVector: [] as number[] }));

vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    getProviderFromModel: () => 'openai',
    EmbeddingFactory: class {
      createEmbeddingService() {
        return { generateEmbedding: async () => h.queryVector };
      }
    },
  };
});

import {
  fileScopedSemanticSearch,
  semanticDataLakeSearch,
  type SemanticDataLakeSearchParams,
} from './semanticDataLakeSearch';

const ADA = 'text-embedding-ada-002';
const SMALL_3 = 'text-embedding-3-small';
const VOYAGE_3 = 'voyage-3';
const TITAN_V2 = 'amazon.titan-embed-text-v2:0';

/** ada-002 and text-embedding-3-small are both this wide, which is why width proves nothing. */
const DIM = 1536;
/** So are voyage-3 and Titan v2, at the other width the keyless fallback produces. */
const SHARED_DIM = 1024;

/** A unit vector in the first two coordinates, padded to `dim`. */
const unit = (first: number, second: number, dim = DIM): number[] => {
  const v = new Array(dim).fill(0);
  v[0] = first;
  v[1] = second;
  return v;
};

const QUERY = unit(1, 0);
/** Cosine 0.72 against QUERY: a genuine but imperfect match. */
const NEAR = unit(0.72, Math.sqrt(1 - 0.72 ** 2));
/** Cosine 1.0 against QUERY - a perfect score from the wrong embedding space. */
const EXACT = unit(1, 0);
/** Right label, wrong width. */
const NARROW = unit(1, 0, 768);

type FileFixture = {
  id: string;
  fileName: string;
  embeddingModel?: string;
  vectorizedChunkCount?: number;
};

const chunk = (
  id: string,
  fabFileId: string,
  text: string,
  vector: number[] | undefined,
  embeddingModel?: string | null
) => ({
  id,
  fabFileId,
  text,
  vector,
  embeddingModel,
});

const params = (over: Partial<SemanticDataLakeSearchParams> = {}): SemanticDataLakeSearchParams => ({
  userId: 'u1',
  query: 'what is the dosing schedule',
  embeddingModel: ADA as SemanticDataLakeSearchParams['embeddingModel'],
  apiKeyTable: { openai: 'k' },
  dataLakeTags: ['datalake:x'],
  dataLakeTagPrefixes: [],
  minScore: 0,
  topK: 5,
  ...over,
});

const adapters = (files: FileFixture[], findVectors: ReturnType<typeof vi.fn>) => ({
  db: {
    fabfiles: {
      search: vi
        .fn()
        .mockResolvedValue({ data: files.map(f => ({ tags: [], ...f })), hasMore: false, total: files.length }),
    },
    fabfilechunks: { findVectorsByFabFileIds: findVectors },
  },
});

/**
 * Keyset-aware chunk reader, matching the real repository: the ranker pages by `afterChunkId` and
 * probes with limit+1, so a mock returning everything at once would not exercise the real path.
 */
const pagedRows = (
  rows: { id: string; fabFileId: string; text: string; vector?: number[]; embeddingModel?: string | null }[]
) =>
  vi.fn((ids: string[], o?: { limit?: number; afterChunkId?: string }) =>
    Promise.resolve(
      rows
        .filter(r => ids.includes(r.fabFileId))
        .filter(r => (o?.afterChunkId ? r.id > o.afterChunkId : true))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, o?.limit ?? 10_000)
    )
  );

beforeEach(() => {
  h.queryVector = QUERY;
});

describe('semanticDataLakeSearch embedding-model mismatch', () => {
  it('keeps a same-width foreign chunk out of results even at a perfect cosine', async () => {
    // The promise of the ticket: a text-embedding-3-small chunk that scores 1.0 against an
    // ada-002 query is cross-space noise, and it must not outrank - or even join - the ada-002
    // chunk that actually answers at 0.72. Both vectors are 1536 wide, so no length check can
    // achieve this. On main the foreign chunk ranks first.
    const findVectors = pagedRows([
      chunk('c-legit', 'legit', 'the real answer', NEAR),
      chunk('c-foreign', 'foreign', 'cross-space noise', EXACT),
    ]);
    const result = await semanticDataLakeSearch(
      params(),
      adapters(
        [
          { id: 'legit', fileName: 'legit.md', embeddingModel: ADA, vectorizedChunkCount: 1 },
          { id: 'foreign', fileName: 'foreign.md', embeddingModel: SMALL_3, vectorizedChunkCount: 1 },
        ],
        findVectors
      )
    );

    expect(result.results.map(r => r.chunkText)).toEqual(['the real answer']);
    expect(result.results[0].score).toBeCloseTo(0.72, 5);
    // The foreign file's vectors were never even loaded, so they cannot spend the chunk cap.

    const m = result.embeddingMismatch;
    expect(m.excludedFiles.count).toBe(1);
    expect(m.excludedFiles.models).toEqual([SMALL_3]);
    expect(m.excludedFiles.estimatedChunks).toBe(1);
    expect(m.excludedFiles.sample[0]).toEqual({
      fileId: 'foreign',
      fileName: 'foreign.md',
      embeddingModel: SMALL_3,
    });
    expect(m.partial).toBe(true);
    // filesInScope still counts everything the scope resolved to, so no existing consumer sees
    // the number shrink; the excluded files are the reported subset.
    expect(result.filesInScope).toBe(2);
    expect(result.chunksScored + m.skippedChunks.total).toBe(result.totalChunksSearched);
  });

  describe('a file split across two embedding spaces, whose FILE label is blank by design', () => {
    // stampChunkEmbeddingModel clears the file label when a credential change mid-ingest leaves a
    // file's chunks in two spaces: no single value is true of both halves. That blank is never
    // foreign, so the file arrives at the ranker intact - and voyage-3 and Titan v2 are both 1024
    // wide, so nothing about the vectors themselves separates the halves either. The chunk's own
    // label is the only evidence left, and reading it is what this pins.
    const splitFile = [{ id: 'split', fileName: 'split.md', vectorizedChunkCount: 2 }];
    const NEAR_1024 = unit(0.72, Math.sqrt(1 - 0.72 ** 2), SHARED_DIM);
    const EXACT_1024 = unit(1, 0, SHARED_DIM);
    const at = (cosine: number) => unit(cosine, Math.sqrt(1 - cosine ** 2), SHARED_DIM);

    beforeEach(() => {
      h.queryVector = unit(1, 0, SHARED_DIM);
    });

    it('keeps the off-model half out of results even at a perfect cosine', async () => {
      // On main the Titan chunk scores 1.0 against a voyage-3 query and ranks FIRST, ahead of the
      // voyage-3 chunk that actually answers at 0.72.
      const findVectors = pagedRows([
        chunk('c-same', 'split', 'the real answer', NEAR_1024, VOYAGE_3),
        chunk('c-other', 'split', 'cross-space noise', EXACT_1024, TITAN_V2),
      ]);
      const result = await semanticDataLakeSearch(
        params({ embeddingModel: VOYAGE_3 as SemanticDataLakeSearchParams['embeddingModel'] }),
        adapters(splitFile, findVectors)
      );

      expect(result.results.map(r => r.chunkText)).toEqual(['the real answer']);
      expect(result.results[0].score).toBeCloseTo(0.72, 5);
      expect(result.embeddingMismatch.skippedChunks.byReason.modelMismatch).toBe(1);
      // No width mismatch to catch it: that is the whole difficulty.
      expect(result.embeddingMismatch.skippedChunks.byReason.dimensionMismatch).toBe(0);
      // And nothing was excluded at the FILE level either - the blank label excludes nobody.
      expect(result.embeddingMismatch.excludedFiles.count).toBe(0);
      // A withheld half is a partial answer and must say so rather than reading as a thin corpus.
      expect(result.embeddingMismatch.partial).toBe(true);
      expect(result.chunksScored + result.embeddingMismatch.skippedChunks.total).toBe(result.totalChunksSearched);
    });

    it('serves the OTHER half unchanged when the query moves to that space', async () => {
      // Symmetry, not a second copy of the case above: neither half is privileged, and a file that
      // returned nothing under both queries would be a guard that had simply emptied the file.
      const findVectors = pagedRows([
        chunk('c-same', 'split', 'the voyage half', NEAR_1024, VOYAGE_3),
        chunk('c-other', 'split', 'the titan half', EXACT_1024, TITAN_V2),
      ]);
      const result = await semanticDataLakeSearch(
        params({ embeddingModel: TITAN_V2 as SemanticDataLakeSearchParams['embeddingModel'] }),
        adapters(splitFile, findVectors)
      );

      expect(result.results.map(r => r.chunkText)).toEqual(['the titan half']);
      expect(result.embeddingMismatch.skippedChunks.byReason.modelMismatch).toBe(1);
    });

    it('spends the per-document cap on surviving chunks, not on the half it is about to drop', async () => {
      // The chunk-label filter and the per-document cap meet exactly once, at the merge, and the
      // order is what keeps them independent: the filter runs before anything enters the candidate
      // pool, the cap runs after. Move the cap above the filter and the Titan chunk takes this
      // file's single slot at a perfect 1.0, then gets dropped - the voyage half that actually
      // answers is never served, and the document silently forfeits its allowance to a chunk no
      // reader can see. Nothing else in either suite would notice.
      const files = [
        { id: 'split', fileName: 'split.md', vectorizedChunkCount: 3 },
        { id: 'other', fileName: 'other.md', vectorizedChunkCount: 1 },
      ];
      const findVectors = pagedRows([
        chunk('c1', 'split', 'the real answer', NEAR_1024, VOYAGE_3),
        chunk('c2', 'split', 'the split runner-up', at(0.6), VOYAGE_3),
        chunk('c3', 'split', 'cross-space noise', EXACT_1024, TITAN_V2),
        chunk('c4', 'other', 'the other file', at(0.5), VOYAGE_3),
      ]);

      const result = await semanticDataLakeSearch(
        params({
          embeddingModel: VOYAGE_3 as SemanticDataLakeSearchParams['embeddingModel'],
          topK: 2,
          budgets: { maxChunksPerFile: 1 },
        }),
        adapters(files, findVectors)
      );

      // Uncapped the split file would hold both slots, at 0.72 and 0.60; the cap hands the second
      // to the other document. The Titan chunk is out of the running under either arrangement.
      expect(result.results.map(r => r.chunkText)).toEqual(['the real answer', 'the other file']);
      expect(result.scan.capPromotions).toBe(1);
      expect(result.embeddingMismatch.skippedChunks.byReason.modelMismatch).toBe(1);
    });
  });

  it('never withholds a file whose embedding model is unset, even under a non-ada query', async () => {
    // FabFile.embeddingModel is optional with no default, so this is every file vectorized
    // before the field existed. Excluding these would empty every legacy lake.
    const findVectors = pagedRows([chunk('c1', 'legacy', 'legacy content', EXACT)]);
    const result = await semanticDataLakeSearch(
      params({ embeddingModel: SMALL_3 as SemanticDataLakeSearchParams['embeddingModel'] }),
      adapters([{ id: 'legacy', fileName: 'legacy.md' }], findVectors)
    );

    expect(result.results.map(r => r.chunkText)).toEqual(['legacy content']);
    expect(result.results[0].score).toBeCloseTo(1, 5);
    expect(result.embeddingMismatch.excludedFiles.count).toBe(0);
    expect(result.embeddingMismatch.skippedChunks.total).toBe(0);
    expect(result.embeddingMismatch.partial).toBe(false);
    // Included, but flagged as unverified rather than silently trusted.
    expect(result.embeddingMismatch.unlabeled).toEqual({ chunks: 1, files: 1 });
  });

  it.each([[''], ['   ']])('treats a blank embedding model (%s) as unset, not foreign', async label => {
    const findVectors = pagedRows([chunk('c1', 'blank', 'kept', EXACT)]);
    const result = await semanticDataLakeSearch(
      params(),
      adapters([{ id: 'blank', fileName: 'blank.md', embeddingModel: label }], findVectors)
    );
    expect(result.results).toHaveLength(1);
    expect(result.embeddingMismatch.excludedFiles.count).toBe(0);
  });

  it('reports nothing and stays quiet when every file agrees with the query', async () => {
    const warn = vi.fn();
    const findVectors = pagedRows([chunk('c1', 'a', 'aligned', NEAR)]);
    const result = await semanticDataLakeSearch(
      params({ logger: { debug: vi.fn(), warn } as unknown as SemanticDataLakeSearchParams['logger'] }),
      adapters([{ id: 'a', fileName: 'a.md', embeddingModel: ADA }], findVectors)
    );
    expect(result.embeddingMismatch.partial).toBe(false);
    expect(result.chunksScored).toBe(1);
    // No log noise on the overwhelmingly common healthy search.
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips a right-labelled chunk whose vector is the wrong width, as a dimension mismatch', async () => {
    const findVectors = vi
      .fn()
      .mockResolvedValue([chunk('narrow', 'a', 'stale width', NARROW), chunk('wide', 'a', 'good', NEAR)]);
    const result = await semanticDataLakeSearch(
      params(),
      adapters([{ id: 'a', fileName: 'a.md', embeddingModel: ADA }], findVectors)
    );

    expect(result.results.map(r => r.chunkText)).toEqual(['good']);
    expect(result.embeddingMismatch.skippedChunks.byReason.dimensionMismatch).toBe(1);
    expect(result.embeddingMismatch.skippedChunks.byReason.modelMismatch).toBe(0);
    // The label agrees, so nothing was excluded at the file level.
    expect(result.embeddingMismatch.excludedFiles.count).toBe(0);
    expect(result.chunksScored).toBe(1);
    expect(result.chunksScored + result.embeddingMismatch.skippedChunks.total).toBe(result.totalChunksSearched);
  });

  // findVectorsByFabFileIds filters vectorless chunks at the DB layer and is only asked for
  // rankable ids, so these two states cannot arise from the repository today - every retrieval path
  // now reads through that filter. The fixtures stay deliberately stricter than the repository so the
  // classifier keeps its own coverage: it is shared, and a future reader that does not filter would
  // otherwise reach it untested.
  it('counts a chunk with no vector as missingVector', async () => {
    const findVectors = pagedRows([chunk('c1', 'a', 'no vector', undefined)]);
    const result = await semanticDataLakeSearch(
      params(),
      adapters([{ id: 'a', fileName: 'a.md', embeddingModel: ADA }], findVectors)
    );
    expect(result.embeddingMismatch.skippedChunks.byReason.missingVector).toBe(1);
    expect(result.results).toEqual([]);
  });

  // (An orphaned chunk is unreachable here now: the scan only requests ids that survived the
  //  partition, so no row can come back without a parent. The case lives in the classifier's own
  //  truth table in embeddingMismatch.test.ts.)

  it('does not count a below-floor chunk as withheld', async () => {
    // Ranked and rejected on merit is not the same as never compared.
    const findVectors = pagedRows([chunk('c1', 'a', 'weak match', NEAR)]);
    const result = await semanticDataLakeSearch(
      params({ minScore: 0.9 }),
      adapters([{ id: 'a', fileName: 'a.md', embeddingModel: ADA }], findVectors)
    );
    expect(result.results).toEqual([]);
    expect(result.chunksScored).toBe(1);
    expect(result.embeddingMismatch.skippedChunks.total).toBe(0);
    expect(result.embeddingMismatch.partial).toBe(false);
  });

  it('skips the chunk query entirely when every file is foreign', async () => {
    const findVectors = pagedRows([]);
    const result = await semanticDataLakeSearch(
      params(),
      adapters(
        [
          { id: 'f1', fileName: 'f1.md', embeddingModel: SMALL_3, vectorizedChunkCount: 4 },
          { id: 'f2', fileName: 'f2.md', embeddingModel: 'voyage-3', vectorizedChunkCount: 6 },
        ],
        findVectors
      )
    );
    expect(findVectors).not.toHaveBeenCalled();
    expect(result.results).toEqual([]);
    expect(result.totalChunksSearched).toBe(0);
    expect(result.embeddingMismatch.excludedFiles.count).toBe(2);
    expect(result.embeddingMismatch.excludedFiles.models).toEqual([SMALL_3, 'voyage-3']);
    expect(result.embeddingMismatch.excludedFiles.estimatedChunks).toBe(10);
    expect(result.embeddingMismatch.partial).toBe(true);
  });

  it('handles a file set whose chunks have not been loaded yet', async () => {
    const findVectors = pagedRows([]);
    const result = await semanticDataLakeSearch(
      params(),
      adapters([{ id: 'a', fileName: 'a.md', embeddingModel: ADA }], findVectors)
    );
    expect(result.results).toEqual([]);
    expect(result.chunksScored).toBe(0);
    expect(result.embeddingMismatch.partial).toBe(false);
  });

  it('reports an empty query embedding instead of ranking against it', async () => {
    h.queryVector = [];
    const findVectors = pagedRows([chunk('c1', 'a', 'content', NEAR)]);
    const result = await semanticDataLakeSearch(
      params(),
      adapters([{ id: 'a', fileName: 'a.md', embeddingModel: ADA }], findVectors)
    );
    // Every chunk would otherwise look like a width mismatch, and the caller must not get a 500.
    expect(findVectors).not.toHaveBeenCalled();
    expect(result.results).toEqual([]);
    expect(result.chunksScored).toBe(0);
    // The report has to name the embedder, not blame the corpus.
    expect(result.embeddingMismatch.queryEmbeddingFailed).toBe(true);
    expect(result.embeddingMismatch.partial).toBe(true);
  });
});

describe('fileScopedSemanticSearch embedding-model mismatch', () => {
  const scopedAdapters = (files: FileFixture[], findVectors: ReturnType<typeof vi.fn>) => ({
    db: {
      fabfiles: { getAccessibleFiles: vi.fn().mockResolvedValue(files.map(f => ({ tags: [], ...f }))) },
      fabfilechunks: { findVectorsByFabFileIds: findVectors },
    },
  });

  it('applies the same exclusion on the agent-scope entrypoint', async () => {
    // Both entrypoints share one ranking core, so an agent KB curated across two vectorization
    // eras gets the identical treatment - and getAccessibleFiles is a different projection.
    const findVectors = pagedRows([chunk('c-legit', 'legit', 'the real answer', NEAR)]);
    const result = await fileScopedSemanticSearch(
      {
        query: 'dosing',
        fileIds: ['legit', 'foreign'],
        embeddingModel: ADA as SemanticDataLakeSearchParams['embeddingModel'],
        apiKeyTable: { openai: 'k' },
        minScore: 0,
      },
      scopedAdapters(
        [
          { id: 'legit', fileName: 'legit.md', embeddingModel: ADA },
          { id: 'foreign', fileName: 'foreign.md', embeddingModel: SMALL_3, vectorizedChunkCount: 3 },
        ],
        findVectors
      )
    );

    expect(result.results.map(r => r.chunkText)).toEqual(['the real answer']);
    expect(result.embeddingMismatch.excludedFiles.count).toBe(1);
    expect(result.embeddingMismatch.excludedFiles.estimatedChunks).toBe(3);
    expect(result.embeddingMismatch.partial).toBe(true);
  });

  it('keeps unlabeled scoped files searchable', async () => {
    const findVectors = pagedRows([chunk('c1', 'legacy', 'legacy content', EXACT)]);
    const result = await fileScopedSemanticSearch(
      {
        query: 'dosing',
        fileIds: ['legacy'],
        embeddingModel: SMALL_3 as SemanticDataLakeSearchParams['embeddingModel'],
        apiKeyTable: { openai: 'k' },
        minScore: 0,
      },
      scopedAdapters([{ id: 'legacy', fileName: 'legacy.md' }], findVectors)
    );
    expect(result.results).toHaveLength(1);
    expect(result.embeddingMismatch.excludedFiles.count).toBe(0);
    expect(result.embeddingMismatch.unlabeled.chunks).toBe(1);
  });
});
