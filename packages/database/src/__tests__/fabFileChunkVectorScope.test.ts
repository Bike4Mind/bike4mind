import { describe, it, expect, beforeEach } from 'vitest';
import { FabFileChunk, fabFileChunkRepository } from '../models/content/FabFileModel';
import { setupMongoTest, testFabFileId as fid } from '../__test__/utils';

// DB-layer guarantee the file-scoped semantic search relies on: the bulk vector load
// returns chunks ONLY for the requested file ids, and only vector-bearing ones.
describe('FabFileChunkRepository.findVectorsByFabFileIds scoping', () => {
  setupMongoTest();

  beforeEach(async () => {
    await FabFileChunk.deleteMany({});
  });

  it('returns chunks only for the requested file ids', async () => {
    await FabFileChunk.create([
      { fabFileId: fid('in-scope'), text: 'in scope chunk', tokenCount: 4, vector: [0.1, 0.2] },
      { fabFileId: fid('out-of-scope'), text: 'other owner chunk', tokenCount: 4, vector: [0.3, 0.4] },
    ]);

    const chunks = await fabFileChunkRepository.findVectorsByFabFileIds([fid('in-scope')]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].fabFileId).toBe(fid('in-scope'));
  });

  it('excludes vectorless chunks of in-scope files', async () => {
    await FabFileChunk.create([
      { fabFileId: fid('in-scope'), text: 'vectorized', tokenCount: 2, vector: [0.1, 0.2] },
      { fabFileId: fid('in-scope'), text: 'not vectorized', tokenCount: 3, vector: [] },
      { fabFileId: fid('in-scope'), text: 'never vectorized', tokenCount: 3 },
    ]);

    const chunks = await fabFileChunkRepository.findVectorsByFabFileIds([fid('in-scope')]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('vectorized');
  });

  it('an empty id list returns nothing', async () => {
    await FabFileChunk.create([{ fabFileId: fid('somewhere'), text: 'chunk', tokenCount: 1, vector: [0.1] }]);

    const chunks = await fabFileChunkRepository.findVectorsByFabFileIds([]);

    expect(chunks).toEqual([]);
  });

  // The projection is the only thing standing between the cosine scans and a blind cross-model
  // guard, and no mocked-repository test can see it: every ranker test hands itself rows that
  // already carry the label. Dropping `embeddingModel` from the `.select()` would leave those
  // suites green while production silently scored a split file's two halves against each other.
  it("projects each chunk's OWN embeddingModel", async () => {
    await FabFileChunk.create([
      { fabFileId: fid('f1'), text: 'voyage half', tokenCount: 1, vector: [0.1, 0.2], embeddingModel: 'voyage-3' },
      {
        fabFileId: fid('f1'),
        text: 'titan half',
        tokenCount: 1,
        vector: [0.3, 0.4],
        embeddingModel: 'amazon.titan-embed-text-v2:0',
      },
    ]);

    const chunks = await fabFileChunkRepository.findVectorsByFabFileIds([fid('f1')]);

    expect(chunks.map(c => c.embeddingModel).sort()).toEqual(['amazon.titan-embed-text-v2:0', 'voyage-3']);
  });

  it('reports an unlabelled chunk as null rather than omitting the field', async () => {
    // The classifier falls back to the file label on a blank chunk label, so the shape has to be
    // stable: a reader cannot distinguish "not projected" from "not labelled" on a missing key.
    await FabFileChunk.create([{ fabFileId: fid('f1'), text: 'legacy', tokenCount: 1, vector: [0.1, 0.2] }]);

    const chunks = await fabFileChunkRepository.findVectorsByFabFileIds([fid('f1')]);

    expect(chunks[0].embeddingModel).toBeNull();
  });
});

// What the FILE label is resolved from at vectorize completion. The distinct query cannot answer
// this on its own: it only sees chunks that already carry a label, so it comes back empty both for
// a file with no vectors at all and for one whose vectors are merely unlabelled so far - and those
// want opposite file labels (see resolveFileLabel in b4m-core/services/src/fabFileService).
describe('FabFileChunkRepository.countUnlabeledVectorChunksByFabFileId', () => {
  setupMongoTest();

  beforeEach(async () => {
    await FabFileChunk.deleteMany({});
  });

  it('counts vector-bearing chunks with no label, however the blank is spelled', async () => {
    await FabFileChunk.create([
      { fabFileId: fid('f1'), text: 'missing field', tokenCount: 1, vector: [0.1] },
      { fabFileId: fid('f1'), text: 'explicit null', tokenCount: 1, vector: [0.2], embeddingModel: null },
      { fabFileId: fid('f1'), text: 'empty string', tokenCount: 1, vector: [0.3], embeddingModel: '' },
      { fabFileId: fid('f1'), text: 'labelled', tokenCount: 1, vector: [0.4], embeddingModel: 'voyage-3' },
    ]);

    expect(await fabFileChunkRepository.countUnlabeledVectorChunksByFabFileId(fid('f1'))).toBe(3);
  });

  it('ignores vectorless chunks - they name no space, so the stamp will not label them', async () => {
    // The all-oversized file: every chunk skipped at embed time, still terminal in the rollup. It
    // must read as zero, or a file with nothing embedded would be labelled from the caller's model.
    await FabFileChunk.create([
      { fabFileId: fid('f1'), text: 'oversized', tokenCount: 99999 },
      { fabFileId: fid('f1'), text: 'also oversized', tokenCount: 99999, vector: [] },
    ]);

    expect(await fabFileChunkRepository.countUnlabeledVectorChunksByFabFileId(fid('f1'))).toBe(0);
  });

  it('is scoped to the requested file', async () => {
    await FabFileChunk.create([
      { fabFileId: fid('f1'), text: 'mine', tokenCount: 1, vector: [0.1] },
      { fabFileId: fid('f2'), text: 'theirs', tokenCount: 1, vector: [0.2] },
    ]);

    expect(await fabFileChunkRepository.countUnlabeledVectorChunksByFabFileId(fid('f1'))).toBe(1);
  });
});

// Per-chunk fields, not FabFile.embeddingModel, are the source of truth here: a re-embedded file's
// chunks can span more than one model (see IFabFileChunk.embeddingModel), and a per-model retrieval
// index removal needs every index a file can have documents in to reach them all. That is the UNION
// of index residency (retrievalIndexModel) and the file-complete readiness stamp (embeddingModel).
describe('FabFileChunkRepository.distinctRetrievalIndexModelsByFabFileIds', () => {
  setupMongoTest();

  beforeEach(async () => {
    await FabFileChunk.deleteMany({});
  });

  it('returns every distinct model across the requested files, deduped', async () => {
    await FabFileChunk.create([
      { fabFileId: fid('f1'), text: 'a', tokenCount: 1, embeddingModel: 'model-a' },
      { fabFileId: fid('f1'), text: 'b', tokenCount: 1, embeddingModel: 'model-b' },
      { fabFileId: fid('f2'), text: 'c', tokenCount: 1, embeddingModel: 'model-a' },
    ]);

    const models = await fabFileChunkRepository.distinctRetrievalIndexModelsByFabFileIds([fid('f1'), fid('f2')]);

    expect(models.sort()).toEqual(['model-a', 'model-b']);
  });

  it('excludes chunks outside the requested file ids', async () => {
    await FabFileChunk.create([
      { fabFileId: fid('in-scope'), text: 'a', tokenCount: 1, embeddingModel: 'model-a' },
      { fabFileId: fid('out-of-scope'), text: 'b', tokenCount: 1, embeddingModel: 'model-b' },
    ]);

    const models = await fabFileChunkRepository.distinctRetrievalIndexModelsByFabFileIds([fid('in-scope')]);

    expect(models).toEqual(['model-a']);
  });

  it('excludes chunks with neither field set', async () => {
    await FabFileChunk.create([{ fabFileId: fid('f1'), text: 'not vectorized', tokenCount: 1 }]);

    const models = await fabFileChunkRepository.distinctRetrievalIndexModelsByFabFileIds([fid('f1')]);

    expect(models).toEqual([]);
  });

  // The bug this pairing exists for: vectorize indexes a message's chunks into OpenSearch, then
  // the file never finishes, so embeddingModel is never stamped. Resolving from the stamp alone
  // reports no index to remove while the documents are still live.
  it('includes a model recorded only as index residency, with no readiness stamp', async () => {
    await FabFileChunk.create([
      { fabFileId: fid('f1'), text: 'indexed but never stamped', tokenCount: 1, retrievalIndexModel: 'model-a' },
    ]);

    const models = await fabFileChunkRepository.distinctRetrievalIndexModelsByFabFileIds([fid('f1')]);

    expect(models).toEqual(['model-a']);
  });

  it('dedupes a model recorded in both fields', async () => {
    await FabFileChunk.create([
      { fabFileId: fid('f1'), text: 'a', tokenCount: 1, retrievalIndexModel: 'model-a', embeddingModel: 'model-a' },
      { fabFileId: fid('f1'), text: 'b', tokenCount: 1, retrievalIndexModel: 'model-b' },
    ]);

    const models = await fabFileChunkRepository.distinctRetrievalIndexModelsByFabFileIds([fid('f1')]);

    expect(models.sort()).toEqual(['model-a', 'model-b']);
  });

  it('an empty id list returns nothing without querying', async () => {
    await FabFileChunk.create([{ fabFileId: fid('f1'), text: 'a', tokenCount: 1, embeddingModel: 'model-a' }]);

    const models = await fabFileChunkRepository.distinctRetrievalIndexModelsByFabFileIds([]);

    expect(models).toEqual([]);
  });
});

// The per-FILE pairing the removal path needs (#2087). The union above cannot express it: pairing
// every file with every model in the batch issues one request per (file, model) cell, most of which
// match nothing, and widens any single index failure to every file in the removal.
describe('FabFileChunkRepository.retrievalIndexModelsByFabFileIds', () => {
  setupMongoTest();

  beforeEach(async () => {
    await FabFileChunk.deleteMany({});
  });

  it('groups models under the file that actually used them', async () => {
    await FabFileChunk.create([
      { fabFileId: fid('f1'), text: 'a', tokenCount: 1, embeddingModel: 'model-a' },
      { fabFileId: fid('f2'), text: 'c', tokenCount: 1, embeddingModel: 'model-b' },
    ]);

    const byFile = await fabFileChunkRepository.retrievalIndexModelsByFabFileIds([fid('f1'), fid('f2')]);

    expect(byFile).toEqual({ [fid('f1')]: ['model-a'], [fid('f2')]: ['model-b'] });
  });

  it('dedupes within a file and keeps every model a re-embedded file spans', async () => {
    await FabFileChunk.create([
      { fabFileId: fid('f1'), text: 'a', tokenCount: 1, embeddingModel: 'model-a' },
      { fabFileId: fid('f1'), text: 'b', tokenCount: 1, embeddingModel: 'model-a' },
      { fabFileId: fid('f1'), text: 'c', tokenCount: 1, embeddingModel: 'model-b' },
    ]);

    const byFile = await fabFileChunkRepository.retrievalIndexModelsByFabFileIds([fid('f1')]);

    expect(byFile[fid('f1')].sort()).toEqual(['model-a', 'model-b']);
  });

  it('omits a requested file with no model-bearing chunks, rather than mapping it to an empty list', async () => {
    // The port iterates this map, so an omitted file is how a no-op removal request is dropped.
    await FabFileChunk.create([
      { fabFileId: fid('f1'), text: 'a', tokenCount: 1, embeddingModel: 'model-a' },
      { fabFileId: fid('f2'), text: 'not vectorized', tokenCount: 1 },
    ]);

    const byFile = await fabFileChunkRepository.retrievalIndexModelsByFabFileIds([
      fid('f1'),
      fid('f2'),
      fid('never-seen'),
    ]);

    expect(byFile).toEqual({ [fid('f1')]: ['model-a'] });
  });

  it('excludes chunks outside the requested file ids', async () => {
    await FabFileChunk.create([
      { fabFileId: fid('in-scope'), text: 'a', tokenCount: 1, embeddingModel: 'model-a' },
      { fabFileId: fid('out-of-scope'), text: 'b', tokenCount: 1, embeddingModel: 'model-b' },
    ]);

    const byFile = await fabFileChunkRepository.retrievalIndexModelsByFabFileIds([fid('in-scope')]);

    expect(byFile).toEqual({ [fid('in-scope')]: ['model-a'] });
  });

  // Same regression as the distinct variant above: a file whose vectorize never finished is
  // present in the purge's fabFileIds but was absent from this map when it keyed on the stamp
  // alone, so the port skipped it and its OpenSearch documents were never removed.
  it('maps a file whose chunks carry only index residency, never a readiness stamp', async () => {
    await FabFileChunk.create([
      { fabFileId: fid('f1'), text: 'indexed but never stamped', tokenCount: 1, retrievalIndexModel: 'model-a' },
    ]);

    const byFile = await fabFileChunkRepository.retrievalIndexModelsByFabFileIds([fid('f1')]);

    expect(byFile).toEqual({ [fid('f1')]: ['model-a'] });
  });

  it('unions the two fields per file and dedupes', async () => {
    await FabFileChunk.create([
      { fabFileId: fid('f1'), text: 'a', tokenCount: 1, retrievalIndexModel: 'model-a', embeddingModel: 'model-a' },
      { fabFileId: fid('f1'), text: 'b', tokenCount: 1, retrievalIndexModel: 'model-b' },
      { fabFileId: fid('f2'), text: 'c', tokenCount: 1, embeddingModel: 'model-c' },
    ]);

    const byFile = await fabFileChunkRepository.retrievalIndexModelsByFabFileIds([fid('f1'), fid('f2')]);

    expect(byFile[fid('f1')].sort()).toEqual(['model-a', 'model-b']);
    expect(byFile[fid('f2')]).toEqual(['model-c']);
  });

  // The write vectorize actually makes: residency rides along with the chunk's vector through
  // `update`. Mongoose drops any field the schema does not declare, so a schema that lost
  // retrievalIndexModel would leave this silently unwritten and the resolvers permanently blind -
  // which no mocked-repository test can catch.
  it('sees residency written by the repository update that carries the vector', async () => {
    const [chunk] = await FabFileChunk.create([{ fabFileId: fid('f1'), text: 'a', tokenCount: 1 }]);

    await fabFileChunkRepository.update({
      id: String(chunk._id),
      vector: [0.1, 0.2],
      retrievalIndexModel: 'model-a',
    });

    const stored = await FabFileChunk.findById(chunk._id);
    expect(stored?.retrievalIndexModel).toBe('model-a');
    expect(stored?.embeddingModel).toBeUndefined();
    expect(await fabFileChunkRepository.retrievalIndexModelsByFabFileIds([fid('f1')])).toEqual({
      [fid('f1')]: ['model-a'],
    });
  });

  it('an empty id list returns nothing without querying', async () => {
    await FabFileChunk.create([{ fabFileId: fid('f1'), text: 'a', tokenCount: 1, embeddingModel: 'model-a' }]);

    expect(await fabFileChunkRepository.retrievalIndexModelsByFabFileIds([])).toEqual({});
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
        fabFileId: fid('lake'),
        text: `chunk ${n - 1 - i}`,
        tokenCount: 2,
        vector: [0.1, 0.2],
      }))
    );
    return created.map(c => String(c._id)).sort();
  };

  it('returns rows ascending by _id regardless of insertion order', async () => {
    const ids = await seed(6);

    const chunks = await fabFileChunkRepository.findVectorsByFabFileIds([fid('lake')]);

    expect(chunks.map(c => c.id)).toEqual(ids);
  });

  it('honours the limit', async () => {
    await seed(6);

    const chunks = await fabFileChunkRepository.findVectorsByFabFileIds([fid('lake')], { limit: 2 });

    expect(chunks).toHaveLength(2);
  });

  it('afterChunkId resumes strictly after that row, so a full walk has no gaps or duplicates', async () => {
    const ids = await seed(7);

    const walked: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const rows = await fabFileChunkRepository.findVectorsByFabFileIds([fid('lake')], {
        limit: 3,
        afterChunkId: cursor,
      });
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

    const first = await fabFileChunkRepository.findVectorsByFabFileIds([fid('lake')], { limit: 3 });
    const second = await fabFileChunkRepository.findVectorsByFabFileIds([fid('lake')], { limit: 3 });

    expect(second.map(c => c.id)).toEqual(first.map(c => c.id));
  });

  it('paging stays scoped to the requested files and still excludes vectorless chunks', async () => {
    await FabFileChunk.create([
      { fabFileId: fid('lake'), text: 'a', tokenCount: 1, vector: [0.1] },
      { fabFileId: fid('lake'), text: 'no vector', tokenCount: 1, vector: [] },
      { fabFileId: fid('other'), text: 'b', tokenCount: 1, vector: [0.1] },
    ]);

    const chunks = await fabFileChunkRepository.findVectorsByFabFileIds([fid('lake')], { limit: 10 });

    expect(chunks.map(c => c.text)).toEqual(['a']);
  });

  it('is served by an index with no in-memory sort stage', async () => {
    // If this regresses, paging a large lake silently becomes a blocking sort. The compound
    // { fabFileId: 1, _id: 1 } index is what keeps the keyset walk streaming.
    await seed(5);
    await FabFileChunk.ensureIndexes();

    const plan = await FabFileChunk.collection
      .find({ fabFileId: { $in: [fid('lake')] }, vector: { $exists: true, $ne: [] } })
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
      { fabFileId: fid('f1'), text: 'vectorized body', tokenCount: 2, vector: [0.1, 0.2] },
      { fabFileId: fid('f1'), text: 'awaiting vectorization', tokenCount: 3 },
    ]);

    const rows = await fabFileChunkRepository.findTextsByFabFileId(fid('f1'));

    expect(rows.map(r => r.text)).toEqual(['vectorized body', 'awaiting vectorization']);
  });

  it('scopes to the requested file', async () => {
    await FabFileChunk.create([
      { fabFileId: fid('mine'), text: 'mine', tokenCount: 1 },
      { fabFileId: fid('theirs'), text: 'theirs', tokenCount: 1 },
    ]);

    const rows = await fabFileChunkRepository.findTextsByFabFileId(fid('mine'));

    expect(rows.map(r => r.text)).toEqual(['mine']);
  });

  it('pages by keyset with no gap and no duplicate', async () => {
    await FabFileChunk.create(
      Array.from({ length: 7 }, (_, i) => ({ fabFileId: fid('f1'), text: `chunk-${i}`, tokenCount: 1 }))
    );

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const rows = await fabFileChunkRepository.findTextsByFabFileId(fid('f1'), { limit: 3, afterChunkId: cursor });
      if (rows.length === 0) break;
      seen.push(...rows.map(r => r.text));
      cursor = rows[rows.length - 1].id;
    }

    expect(seen).toEqual(['chunk-0', 'chunk-1', 'chunk-2', 'chunk-3', 'chunk-4', 'chunk-5', 'chunk-6']);
    expect(new Set(seen).size).toBe(7);
  });

  it('respects limit', async () => {
    await FabFileChunk.create(
      Array.from({ length: 5 }, (_, i) => ({ fabFileId: fid('f1'), text: `chunk-${i}`, tokenCount: 1 }))
    );

    const rows = await fabFileChunkRepository.findTextsByFabFileId(fid('f1'), { limit: 2 });

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
      { fabFileId: fid('f1'), text: 'a', tokenCount: 1, vector: [0.1] },
      { fabFileId: fid('f1'), text: 'b', tokenCount: 1, vector: [] },
      { fabFileId: fid('f1'), text: 'c', tokenCount: 1 },
      { fabFileId: fid('f2'), text: 'other', tokenCount: 1, vector: [0.1] },
    ]);

    expect(await fabFileChunkRepository.countByFabFileId(fid('f1'))).toBe(3);
    expect(await fabFileChunkRepository.countByFabFileId(fid('f2'))).toBe(1);
    expect(await fabFileChunkRepository.countByFabFileId(fid('absent'))).toBe(0);
  });
});

// The RETRIEVAL-side counterpart to the two removal resolvers above, and the opposite bias: a file
// counts as resident only when every chunk dispatched to the index came back confirmed. Claiming
// one that is not there makes it ANN-eligible and permanently empty, with no error anywhere.
describe('FabFileChunkRepository.annResidentFabFileIds', () => {
  setupMongoTest();

  beforeEach(async () => {
    await FabFileChunk.deleteMany({});
  });

  // embeddingModel is always set alongside retrievalIndexModel on the real write path
  // (fabFileVectorize.ts writes both in the same transaction when self-host is on) - the
  // denominator below keys on embeddingModel specifically because it CANNOT be skipped, unlike
  // retrievalIndexModel (see the straddle test below).
  const dispatched = (fabFileId: string, text: string, confirmed: boolean, model = 'model-a') => ({
    fabFileId,
    text,
    tokenCount: 1,
    embeddingModel: model,
    retrievalIndexModel: model,
    ...(confirmed ? { retrievalIndexConfirmedModel: model } : {}),
  });

  it('returns a file whose every dispatched chunk is confirmed', async () => {
    await FabFileChunk.create([dispatched('f1', 'a', true), dispatched('f1', 'b', true)]);

    expect(await fabFileChunkRepository.annResidentFabFileIds(['f1'], 'model-a')).toEqual(['f1']);
  });

  it('withholds a file with even one unconfirmed chunk - a half-indexed file serves half its content', async () => {
    await FabFileChunk.create([dispatched('f1', 'a', true), dispatched('f1', 'b', false)]);

    expect(await fabFileChunkRepository.annResidentFabFileIds(['f1'], 'model-a')).toEqual([]);
  });

  it('withholds a file that predates the feature - it was embedded but never dispatched to the index', async () => {
    await FabFileChunk.create([{ fabFileId: 'f1', text: 'a', tokenCount: 1, embeddingModel: 'model-a' }]);

    expect(await fabFileChunkRepository.annResidentFabFileIds(['f1'], 'model-a')).toEqual([]);
  });

  it('withholds a file straddling a rolling self-host enable - a chunk embedded before the flag flipped carries no retrievalIndexModel or confirm, but still counts toward the denominator', async () => {
    // Regression coverage for the denominator switching from retrievalIndexModel to
    // embeddingModel: under the old denominator this file would have been reported resident,
    // since the un-dispatched chunk was invisible to the count entirely.
    await FabFileChunk.create([
      dispatched('f1', 'a', true),
      { fabFileId: 'f1', text: 'b', tokenCount: 1, embeddingModel: 'model-a' },
    ]);

    expect(await fabFileChunkRepository.annResidentFabFileIds(['f1'], 'model-a')).toEqual([]);
  });

  it('answers per model, so a file resident under one is not claimed for another', async () => {
    await FabFileChunk.create([dispatched('f1', 'a', true, 'model-a'), dispatched('f1', 'b', false, 'model-b')]);

    expect(await fabFileChunkRepository.annResidentFabFileIds(['f1'], 'model-a')).toEqual(['f1']);
    expect(await fabFileChunkRepository.annResidentFabFileIds(['f1'], 'model-b')).toEqual([]);
  });

  it('excludes files outside the requested ids and returns nothing for an empty list', async () => {
    await FabFileChunk.create([dispatched('in-scope', 'a', true), dispatched('out-of-scope', 'b', true)]);

    expect(await fabFileChunkRepository.annResidentFabFileIds(['in-scope'], 'model-a')).toEqual(['in-scope']);
    expect(await fabFileChunkRepository.annResidentFabFileIds([], 'model-a')).toEqual([]);
  });
});

describe('FabFileChunkRepository.confirmRetrievalIndexed', () => {
  setupMongoTest();

  beforeEach(async () => {
    await FabFileChunk.deleteMany({});
  });

  it('stamps only the chunks it was given, leaving the rest of the batch unconfirmed', async () => {
    const [c1, c2] = await FabFileChunk.create([
      { fabFileId: 'f1', text: 'a', tokenCount: 1, embeddingModel: 'model-a', retrievalIndexModel: 'model-a' },
      { fabFileId: 'f1', text: 'b', tokenCount: 1, embeddingModel: 'model-a', retrievalIndexModel: 'model-a' },
    ]);

    await fabFileChunkRepository.confirmRetrievalIndexed([c1.id], 'model-a');

    expect((await FabFileChunk.findById(c1.id))?.retrievalIndexConfirmedModel).toBe('model-a');
    expect((await FabFileChunk.findById(c2.id))?.retrievalIndexConfirmedModel).toBeUndefined();
    expect(await fabFileChunkRepository.annResidentFabFileIds(['f1'], 'model-a')).toEqual([]);
  });

  it('is a no-op on an empty id list', async () => {
    await expect(fabFileChunkRepository.confirmRetrievalIndexed([], 'model-a')).resolves.toBeUndefined();
  });
});

describe('FabFileChunkRepository.clearRetrievalIndexConfirmed', () => {
  setupMongoTest();

  beforeEach(async () => {
    await FabFileChunk.deleteMany({});
  });

  it('unsets a stale confirm - a rollback deleted the OpenSearch doc a prior delivery confirmed', async () => {
    const [c1, c2] = await FabFileChunk.create([
      {
        fabFileId: 'f1',
        text: 'a',
        tokenCount: 1,
        embeddingModel: 'model-a',
        retrievalIndexModel: 'model-a',
        retrievalIndexConfirmedModel: 'model-a',
      },
      {
        fabFileId: 'f1',
        text: 'b',
        tokenCount: 1,
        embeddingModel: 'model-a',
        retrievalIndexModel: 'model-a',
        retrievalIndexConfirmedModel: 'model-a',
      },
    ]);

    await fabFileChunkRepository.clearRetrievalIndexConfirmed([c1.id], 'model-a');

    expect((await FabFileChunk.findById(c1.id))?.retrievalIndexConfirmedModel).toBeUndefined();
    expect((await FabFileChunk.findById(c2.id))?.retrievalIndexConfirmedModel).toBe('model-a');
    expect(await fabFileChunkRepository.annResidentFabFileIds(['f1'], 'model-a')).toEqual([]);
  });

  it('never clears a confirm for a different model', async () => {
    const [c1] = await FabFileChunk.create([
      {
        fabFileId: 'f1',
        text: 'a',
        tokenCount: 1,
        embeddingModel: 'model-a',
        retrievalIndexModel: 'model-a',
        retrievalIndexConfirmedModel: 'model-a',
      },
    ]);

    await fabFileChunkRepository.clearRetrievalIndexConfirmed([c1.id], 'model-b');

    expect((await FabFileChunk.findById(c1.id))?.retrievalIndexConfirmedModel).toBe('model-a');
  });

  it('is a no-op on an empty id list', async () => {
    await expect(fabFileChunkRepository.clearRetrievalIndexConfirmed([], 'model-a')).resolves.toBeUndefined();
  });
});
