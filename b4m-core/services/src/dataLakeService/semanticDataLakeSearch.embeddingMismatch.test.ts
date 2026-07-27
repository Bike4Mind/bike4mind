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

/** ada-002 and text-embedding-3-small are both this wide, which is why width proves nothing. */
const DIM = 1536;

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

const chunk = (id: string, fabFileId: string, text: string, vector: number[] | undefined) => ({
  id,
  fabFileId,
  text,
  vector,
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
    fabfiles: { search: vi.fn().mockResolvedValue({ data: files.map(f => ({ tags: [], ...f })) }) },
    fabfilechunks: { findVectorsByFabFileIds: findVectors },
  },
});

beforeEach(() => {
  h.queryVector = QUERY;
});

describe('semanticDataLakeSearch embedding-model mismatch', () => {
  it('keeps a same-width foreign chunk out of results even at a perfect cosine', async () => {
    // The promise of the ticket: a text-embedding-3-small chunk that scores 1.0 against an
    // ada-002 query is cross-space noise, and it must not outrank - or even join - the ada-002
    // chunk that actually answers at 0.72. Both vectors are 1536 wide, so no length check can
    // achieve this. On main the foreign chunk ranks first.
    const findVectors = vi
      .fn()
      .mockResolvedValue([
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
    // cap + 1: the probe row that distinguishes a full page from a truncated one.
    expect(findVectors).toHaveBeenCalledWith(['legit'], 10_001);

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

  it('never withholds a file whose embedding model is unset, even under a non-ada query', async () => {
    // FabFile.embeddingModel is optional with no default, so this is every file vectorized
    // before the field existed. Excluding these would empty every legacy lake.
    const findVectors = vi.fn().mockResolvedValue([chunk('c1', 'legacy', 'legacy content', EXACT)]);
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
    const findVectors = vi.fn().mockResolvedValue([chunk('c1', 'blank', 'kept', EXACT)]);
    const result = await semanticDataLakeSearch(
      params(),
      adapters([{ id: 'blank', fileName: 'blank.md', embeddingModel: label }], findVectors)
    );
    expect(result.results).toHaveLength(1);
    expect(result.embeddingMismatch.excludedFiles.count).toBe(0);
  });

  it('reports nothing and stays quiet when every file agrees with the query', async () => {
    const warn = vi.fn();
    const findVectors = vi.fn().mockResolvedValue([chunk('c1', 'a', 'aligned', NEAR)]);
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
  // rankable ids, so these two states cannot arise on THIS path today. They are reachable on the
  // forced-retrieval path (findByFabFileId, unfiltered), which shares the classifier, so the
  // fixtures are deliberately stricter than the repo to keep the wiring covered from both ends.
  it('counts a chunk with no vector as missingVector', async () => {
    const findVectors = vi.fn().mockResolvedValue([chunk('c1', 'a', 'no vector', undefined)]);
    const result = await semanticDataLakeSearch(
      params(),
      adapters([{ id: 'a', fileName: 'a.md', embeddingModel: ADA }], findVectors)
    );
    expect(result.embeddingMismatch.skippedChunks.byReason.missingVector).toBe(1);
    expect(result.results).toEqual([]);
  });

  it('counts an orphaned chunk as unknownFile', async () => {
    const findVectors = vi.fn().mockResolvedValue([chunk('c1', 'vanished', 'orphan', EXACT)]);
    const result = await semanticDataLakeSearch(
      params(),
      adapters([{ id: 'a', fileName: 'a.md', embeddingModel: ADA }], findVectors)
    );
    expect(result.embeddingMismatch.skippedChunks.byReason.unknownFile).toBe(1);
    expect(result.results).toEqual([]);
  });

  it('does not count a below-floor chunk as withheld', async () => {
    // Ranked and rejected on merit is not the same as never compared.
    const findVectors = vi.fn().mockResolvedValue([chunk('c1', 'a', 'weak match', NEAR)]);
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
    const findVectors = vi.fn().mockResolvedValue([]);
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
    const findVectors = vi.fn().mockResolvedValue([]);
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
    const findVectors = vi.fn().mockResolvedValue([chunk('c1', 'a', 'content', NEAR)]);
    const result = await semanticDataLakeSearch(
      params(),
      adapters([{ id: 'a', fileName: 'a.md', embeddingModel: ADA }], findVectors)
    );
    // Every chunk would otherwise look like a width mismatch, and the caller must not get a 500.
    expect(findVectors).not.toHaveBeenCalled();
    expect(result.results).toEqual([]);
    expect(result.chunksScored).toBe(0);
  });

  it('flags a hit chunk-load cap so a truncated search is not reported as complete', async () => {
    // cap+1 rows come back, so there genuinely is more than the cap.
    const findVectors = vi
      .fn()
      .mockResolvedValue([
        chunk('c1', 'a', 'one', NEAR),
        chunk('c2', 'a', 'two', NEAR),
        chunk('c3', 'a', 'three', NEAR),
      ]);
    const result = await semanticDataLakeSearch(
      params({ chunkLoadCap: 2 }),
      adapters([{ id: 'a', fileName: 'a.md', embeddingModel: ADA }], findVectors)
    );
    expect(result.embeddingMismatch.truncated.chunkCapHit).toBe(true);
    // The extra probe row is dropped, so the counts still reflect the cap.
    expect(result.totalChunksSearched).toBe(2);
    // Recorded, but a cap is not an embedding-space problem: a large healthy lake hits it on
    // every search, so it must not raise the partial flag.
    expect(result.embeddingMismatch.partial).toBe(false);
  });

  it('flags a hit file cap from the search page probe', async () => {
    const findVectors = vi.fn().mockResolvedValue([]);
    const result = await semanticDataLakeSearch(params(), {
      db: {
        fabfiles: {
          search: vi.fn().mockResolvedValue({
            data: [{ id: 'a', fileName: 'a.md', tags: [], embeddingModel: ADA }],
            hasMore: true,
            total: 4321,
          }),
        },
        fabfilechunks: { findVectorsByFabFileIds: findVectors },
      },
    });
    expect(result.embeddingMismatch.truncated).toEqual({ chunkCapHit: false, fileCapHit: true, filesTotal: 4321 });
    expect(result.embeddingMismatch.partial).toBe(false);
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
    const findVectors = vi.fn().mockResolvedValue([chunk('c-legit', 'legit', 'the real answer', NEAR)]);
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

    // cap + 1: the probe row that distinguishes a full page from a truncated one.
    expect(findVectors).toHaveBeenCalledWith(['legit'], 10_001);
    expect(result.results.map(r => r.chunkText)).toEqual(['the real answer']);
    expect(result.embeddingMismatch.excludedFiles.count).toBe(1);
    expect(result.embeddingMismatch.excludedFiles.estimatedChunks).toBe(3);
    expect(result.embeddingMismatch.partial).toBe(true);
  });

  it('keeps unlabeled scoped files searchable', async () => {
    const findVectors = vi.fn().mockResolvedValue([chunk('c1', 'legacy', 'legacy content', EXACT)]);
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
