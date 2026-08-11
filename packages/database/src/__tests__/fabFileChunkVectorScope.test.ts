import { describe, it, expect, beforeEach } from 'vitest';
import { FabFileChunk, fabFileChunkRepository } from '../models/content/FabFileModel';
import { setupMongoTest } from '../__test__/utils';

// DB-layer guarantee the file-scoped semantic search relies on: the bulk vector load
// returns chunks ONLY for the requested file ids, and only vector-bearing ones.
describe('FabFileChunkRepository.findVectorsByFabFileIds scoping', () => {
  setupMongoTest();

  beforeEach(async () => {
    await FabFileChunk.deleteMany({});
  });

  it('returns chunks only for the requested file ids', async () => {
    await FabFileChunk.create([
      { fabFileId: 'in-scope', text: 'in scope chunk', tokenCount: 4, vector: [0.1, 0.2] },
      { fabFileId: 'out-of-scope', text: 'other owner chunk', tokenCount: 4, vector: [0.3, 0.4] },
    ]);

    const chunks = await fabFileChunkRepository.findVectorsByFabFileIds(['in-scope']);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].fabFileId).toBe('in-scope');
  });

  it('excludes vectorless chunks of in-scope files', async () => {
    await FabFileChunk.create([
      { fabFileId: 'in-scope', text: 'vectorized', tokenCount: 2, vector: [0.1, 0.2] },
      { fabFileId: 'in-scope', text: 'not vectorized', tokenCount: 3, vector: [] },
      { fabFileId: 'in-scope', text: 'never vectorized', tokenCount: 3 },
    ]);

    const chunks = await fabFileChunkRepository.findVectorsByFabFileIds(['in-scope']);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('vectorized');
  });

  it('an empty id list returns nothing', async () => {
    await FabFileChunk.create([{ fabFileId: 'somewhere', text: 'chunk', tokenCount: 1, vector: [0.1] }]);

    const chunks = await fabFileChunkRepository.findVectorsByFabFileIds([]);

    expect(chunks).toEqual([]);
  });
});

// Per-chunk embeddingModel, not FabFile.embeddingModel, is the source of truth here: a
// re-embedded file's chunks can span more than one model (see IFabFileChunk.embeddingModel), and
// a per-model retrieval index removal needs every model actually in use to reach every index.
describe('FabFileChunkRepository.distinctEmbeddingModelsByFabFileIds', () => {
  setupMongoTest();

  beforeEach(async () => {
    await FabFileChunk.deleteMany({});
  });

  it('returns every distinct model across the requested files, deduped', async () => {
    await FabFileChunk.create([
      { fabFileId: 'f1', text: 'a', tokenCount: 1, embeddingModel: 'model-a' },
      { fabFileId: 'f1', text: 'b', tokenCount: 1, embeddingModel: 'model-b' },
      { fabFileId: 'f2', text: 'c', tokenCount: 1, embeddingModel: 'model-a' },
    ]);

    const models = await fabFileChunkRepository.distinctEmbeddingModelsByFabFileIds(['f1', 'f2']);

    expect(models.sort()).toEqual(['model-a', 'model-b']);
  });

  it('excludes chunks outside the requested file ids', async () => {
    await FabFileChunk.create([
      { fabFileId: 'in-scope', text: 'a', tokenCount: 1, embeddingModel: 'model-a' },
      { fabFileId: 'out-of-scope', text: 'b', tokenCount: 1, embeddingModel: 'model-b' },
    ]);

    const models = await fabFileChunkRepository.distinctEmbeddingModelsByFabFileIds(['in-scope']);

    expect(models).toEqual(['model-a']);
  });

  it('excludes chunks with no embeddingModel yet', async () => {
    await FabFileChunk.create([{ fabFileId: 'f1', text: 'not vectorized', tokenCount: 1 }]);

    const models = await fabFileChunkRepository.distinctEmbeddingModelsByFabFileIds(['f1']);

    expect(models).toEqual([]);
  });

  it('an empty id list returns nothing without querying', async () => {
    await FabFileChunk.create([{ fabFileId: 'f1', text: 'a', tokenCount: 1, embeddingModel: 'model-a' }]);

    const models = await fabFileChunkRepository.distinctEmbeddingModelsByFabFileIds([]);

    expect(models).toEqual([]);
  });
});

/**
 * The keyset contract the streaming ranker depends on. Without a total order and an exact cursor,
 * paging a corpus can skip or repeat chunks and retrieval results stop being reproducible - which
 * is the defect the unsorted `.limit(cap)` had.
 */
describe('FabFileChunkRepository.findVectorsByFabFileIds keyset paging', () => {
  setupMongoTest();

  beforeEach(async () => {
    await FabFileChunk.deleteMany({});
  });

  /** Insert in a deliberately non-ascending text order so ordering can't come from insertion. */
  const seed = async (n: number) => {
    const created = await FabFileChunk.create(
      Array.from({ length: n }, (_, i) => ({
        fabFileId: 'lake',
        text: `chunk ${n - 1 - i}`,
        tokenCount: 2,
        vector: [0.1, 0.2],
      }))
    );
    return created.map(c => String(c._id)).sort();
  };

  it('returns rows ascending by _id regardless of insertion order', async () => {
    const ids = await seed(6);

    const chunks = await fabFileChunkRepository.findVectorsByFabFileIds(['lake']);

    expect(chunks.map(c => c.id)).toEqual(ids);
  });

  it('honours the limit', async () => {
    await seed(6);

    const chunks = await fabFileChunkRepository.findVectorsByFabFileIds(['lake'], { limit: 2 });

    expect(chunks).toHaveLength(2);
  });

  it('afterChunkId resumes strictly after that row, so a full walk has no gaps or duplicates', async () => {
    const ids = await seed(7);

    const walked: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const rows = await fabFileChunkRepository.findVectorsByFabFileIds(['lake'], { limit: 3, afterChunkId: cursor });
      if (rows.length === 0) break;
      walked.push(...rows.map(r => r.id));
      cursor = rows[rows.length - 1].id;
    }

    expect(walked).toEqual(ids);
    expect(new Set(walked).size).toBe(walked.length);
  });

  it('two identical truncating reads return the same rows', async () => {
    // The old unsorted query could return a different arbitrary slice each time.
    await seed(8);

    const first = await fabFileChunkRepository.findVectorsByFabFileIds(['lake'], { limit: 3 });
    const second = await fabFileChunkRepository.findVectorsByFabFileIds(['lake'], { limit: 3 });

    expect(second.map(c => c.id)).toEqual(first.map(c => c.id));
  });

  it('paging stays scoped to the requested files and still excludes vectorless chunks', async () => {
    await FabFileChunk.create([
      { fabFileId: 'lake', text: 'a', tokenCount: 1, vector: [0.1] },
      { fabFileId: 'lake', text: 'no vector', tokenCount: 1, vector: [] },
      { fabFileId: 'other', text: 'b', tokenCount: 1, vector: [0.1] },
    ]);

    const chunks = await fabFileChunkRepository.findVectorsByFabFileIds(['lake'], { limit: 10 });

    expect(chunks.map(c => c.text)).toEqual(['a']);
  });

  it('is served by an index with no in-memory sort stage', async () => {
    // If this regresses, paging a large lake silently becomes a blocking sort. The compound
    // { fabFileId: 1, _id: 1 } index is what keeps the keyset walk streaming.
    await seed(5);
    await FabFileChunk.ensureIndexes();

    const plan = await FabFileChunk.collection
      .find({ fabFileId: { $in: ['lake'] }, vector: { $exists: true, $ne: [] } })
      .sort({ _id: 1 })
      .limit(3)
      .explain('queryPlanner');

    const stages = JSON.stringify(plan.queryPlanner.winningPlan);
    // Naming the index matters: with only `_id_` present the planner still satisfies sort({_id:1})
    // by an _id scan plus fetch-and-filter, so asserting IXSCAN alone passes even with the compound
    // gone and pins nothing.
    expect(stages).toContain('"indexName":"fabFileId_1__id_1"');
    expect(stages).not.toContain('"stage":"SORT"');
  });
});

/**
 * The text reader is deliberately NOT the vector reader with a different projection: a text
 * consumer needs every chunk, and inheriting `vector: { $exists: true, $ne: [] }` would drop
 * content that has no embedding yet.
 */
describe('FabFileChunkRepository.findTextsByFabFileId', () => {
  setupMongoTest();

  beforeEach(async () => {
    await FabFileChunk.deleteMany({});
  });

  it('returns vectorless chunks too', async () => {
    await FabFileChunk.create([
      { fabFileId: 'f1', text: 'vectorized body', tokenCount: 2, vector: [0.1, 0.2] },
      { fabFileId: 'f1', text: 'awaiting vectorization', tokenCount: 3 },
    ]);

    const rows = await fabFileChunkRepository.findTextsByFabFileId('f1');

    expect(rows.map(r => r.text)).toEqual(['vectorized body', 'awaiting vectorization']);
  });

  it('scopes to the requested file', async () => {
    await FabFileChunk.create([
      { fabFileId: 'mine', text: 'mine', tokenCount: 1 },
      { fabFileId: 'theirs', text: 'theirs', tokenCount: 1 },
    ]);

    const rows = await fabFileChunkRepository.findTextsByFabFileId('mine');

    expect(rows.map(r => r.text)).toEqual(['mine']);
  });

  it('pages by keyset with no gap and no duplicate', async () => {
    await FabFileChunk.create(
      Array.from({ length: 7 }, (_, i) => ({ fabFileId: 'f1', text: `chunk-${i}`, tokenCount: 1 }))
    );

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const rows = await fabFileChunkRepository.findTextsByFabFileId('f1', { limit: 3, afterChunkId: cursor });
      if (rows.length === 0) break;
      seen.push(...rows.map(r => r.text));
      cursor = rows[rows.length - 1].id;
    }

    expect(seen).toEqual(['chunk-0', 'chunk-1', 'chunk-2', 'chunk-3', 'chunk-4', 'chunk-5', 'chunk-6']);
    expect(new Set(seen).size).toBe(7);
  });

  it('respects limit', async () => {
    await FabFileChunk.create(
      Array.from({ length: 5 }, (_, i) => ({ fabFileId: 'f1', text: `chunk-${i}`, tokenCount: 1 }))
    );

    const rows = await fabFileChunkRepository.findTextsByFabFileId('f1', { limit: 2 });

    expect(rows).toHaveLength(2);
  });
});

describe('FabFileChunkRepository.countByFabFileId', () => {
  setupMongoTest();

  beforeEach(async () => {
    await FabFileChunk.deleteMany({});
  });

  it('counts vectorless chunks as well, and only the requested file', async () => {
    // This is the whole reason the method exists: a caller comparing "chunks delivered" against a
    // count that excluded vectorless chunks would report a partial file as complete.
    await FabFileChunk.create([
      { fabFileId: 'f1', text: 'a', tokenCount: 1, vector: [0.1] },
      { fabFileId: 'f1', text: 'b', tokenCount: 1, vector: [] },
      { fabFileId: 'f1', text: 'c', tokenCount: 1 },
      { fabFileId: 'f2', text: 'other', tokenCount: 1, vector: [0.1] },
    ]);

    expect(await fabFileChunkRepository.countByFabFileId('f1')).toBe(3);
    expect(await fabFileChunkRepository.countByFabFileId('f2')).toBe(1);
    expect(await fabFileChunkRepository.countByFabFileId('absent')).toBe(0);
  });
});
