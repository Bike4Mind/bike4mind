import { describe, it, expect } from 'vitest';
import { FabFileChunk } from '../models/content/FabFileModel';
import { setupMongoTest, testFabFileId as fid } from '../__test__/utils';

/**
 * The fabfilechunks index set is deliberately minimal: one compound index serves both the keyset
 * chunk walk and every bare `fabFileId` read, and a second compound covers the residency
 * aggregate (annResidentFabFileIds). Two regressions would undo that silently - a stray
 * declaration creeping back onto the schema (autoIndex builds whatever is declared, so it
 * returns on the next cold boot), or either compound going away. The plan tests below name the
 * indexes rather than just asserting "some index scan", because a resurrected `{ fabFileId: 1 }`
 * would satisfy the weaker form while being exactly the thing we do not want back.
 */
describe('fabfilechunks indexes', () => {
  setupMongoTest();

  // schema.indexes() also reports field-level `index: true` / `unique: true`, so this covers the
  // route CLAUDE.md forbids as well as an explicit declaration.
  it('declares exactly two indexes: the keyset compound and the residency compound', () => {
    expect(FabFileChunk.schema.indexes().map(([key]) => key)).toEqual([
      { fabFileId: 1, _id: 1 },
      { fabFileId: 1, embeddingModel: 1, retrievalIndexConfirmedModel: 1 },
    ]);
  });

  it('builds only the _id index and the two declared compounds', async () => {
    await FabFileChunk.createIndexes();

    const names = (await FabFileChunk.collection.indexes()).map(index => index.name).sort();
    expect(names).toEqual(['_id_', 'fabFileId_1__id_1', 'fabFileId_1_embeddingModel_1_retrievalIndexConfirmedModel_1']);
  });

  // Key-pattern serialization contract for 20260810000000_drop-legacy-fabfilechunk-indexes.ts,
  // which removes the two orphans left in already-deployed environments. That migration never
  // hardcodes a name - it matches indexes by JSON.stringify(index.key) - so what this pins is that
  // the two legacy key patterns serialize to exactly the strings the migration compares against.
  // This test cannot fail on a regression in this file's own subject - it builds the legacy indexes
  // itself - but a mismatched serialization here would make the migration's own match silently miss.
  it('derives the legacy index names a drop migration has to reference', async () => {
    await FabFileChunk.collection.createIndex({ _id: 1, fabFileId: 1 });
    await FabFileChunk.collection.createIndex({ fabFileId: 1 });

    const byKey = new Map(
      (await FabFileChunk.collection.indexes()).map(index => [JSON.stringify(index.key), index.name])
    );
    expect(byKey.get('{"_id":1,"fabFileId":1}')).toBe('_id_1_fabFileId_1');
    expect(byKey.get('{"fabFileId":1}')).toBe('fabFileId_1');
  });

  it('serves the multi-file keyset walk by merging per-file scans instead of sorting', async () => {
    // What the compound is actually for. Both plan assertions elsewhere use a single-id $in, which
    // never exercises the SORT_MERGE across files that keeps a large lake walk non-blocking.
    await FabFileChunk.create(
      [fid('a'), fid('b'), fid('c')].flatMap(fabFileId =>
        Array.from({ length: 8 }, (_, i) => ({ fabFileId, text: `${fabFileId}${i}`, tokenCount: 2, vector: [0.1] }))
      )
    );
    await FabFileChunk.createIndexes();

    const plan = await FabFileChunk.collection
      .find({ fabFileId: { $in: [fid('a'), fid('b'), fid('c')] }, vector: { $exists: true, $ne: [] } })
      .sort({ _id: 1 })
      .limit(5)
      .explain('queryPlanner');

    const stages = JSON.stringify(plan.queryPlanner.winningPlan);
    expect(stages).toContain('SORT_MERGE');
    expect(stages).toContain('"indexName":"fabFileId_1__id_1"');
    expect(stages).not.toContain('"stage":"SORT"');
  });

  it('serves a resumed keyset page from the same index', async () => {
    // Page 2..N is where a large walk spends its time, and no other test explains a cursored page.
    await FabFileChunk.create(
      Array.from({ length: 10 }, (_, i) => ({ fabFileId: fid('lake'), text: `c${i}`, tokenCount: 2, vector: [0.1] }))
    );
    await FabFileChunk.createIndexes();
    const first = await FabFileChunk.collection
      .find({ fabFileId: fid('lake') })
      .sort({ _id: 1 })
      .limit(3)
      .toArray();

    const plan = await FabFileChunk.collection
      .find({
        fabFileId: { $in: [fid('lake')] },
        vector: { $exists: true, $ne: [] },
        _id: { $gt: first[first.length - 1]._id },
      })
      .sort({ _id: 1 })
      .limit(3)
      .explain('queryPlanner');

    const stages = JSON.stringify(plan.queryPlanner.winningPlan);
    expect(stages).toContain('"indexName":"fabFileId_1__id_1"');
    expect(stages).not.toContain('"stage":"SORT"');
  });

  it('serves a bare fabFileId read from the compound leftmost prefix', async () => {
    // The load-bearing claim for carrying no standalone `{ fabFileId: 1 }`: findByFabFileId,
    // findTextsByFabFileId, countByFabFileId, deleteManyByFabFileId and computeChunkVectorRollup all
    // filter on fabFileId alone and must still get an index scan rather than a collection scan.
    await FabFileChunk.create(
      Array.from({ length: 60 }, (_, i) => ({
        fabFileId: i % 12 === 0 ? fid('lake') : fid('other'),
        text: `chunk ${i}`,
        tokenCount: 2,
      }))
    );
    await FabFileChunk.createIndexes();

    const plan = await FabFileChunk.collection.find({ fabFileId: fid('lake') }).explain('queryPlanner');

    // Substring checks on the serialized plan, matching fabFileChunkVectorScope.test.ts: MongoDB's
    // SBE nests the classic plan under winningPlan.queryPlan, so a structural path assertion would
    // break across mongodb-memory-server binary versions.
    const stages = JSON.stringify(plan.queryPlanner.winningPlan);
    expect(stages).toContain('"indexName":"fabFileId_1__id_1"');
    expect(stages).not.toContain('COLLSCAN');
  });

  it('serves the residency aggregate from the index alone, with no document fetch', async () => {
    // Runs the SAME pipeline `annResidentFabFileIds` issues (FabFileModel.ts), not a `.find()`
    // proxy for it - a `.find()` with a matching filter can stay covered while the real
    // $match/$group/$match pipeline stops being covered, which is exactly the plan-drift shape
    // this index exists to prevent. Keep this pipeline literal in sync with that method's.
    await FabFileChunk.create(
      Array.from({ length: 20 }, (_, i) => ({
        fabFileId: fid('lake'),
        text: `chunk ${i}`,
        tokenCount: 2,
        embeddingModel: 'model-a',
        retrievalIndexConfirmedModel: 'model-a',
      }))
    );
    await FabFileChunk.createIndexes();

    const pipeline = [
      { $match: { fabFileId: { $in: [fid('lake')] }, embeddingModel: 'model-a' } },
      {
        $group: {
          _id: '$fabFileId',
          dispatched: { $sum: 1 },
          confirmed: { $sum: { $cond: [{ $eq: ['$retrievalIndexConfirmedModel', 'model-a'] }, 1, 0] } },
        },
      },
      { $match: { $expr: { $eq: ['$confirmed', '$dispatched'] } } },
    ];

    const explainResult = await FabFileChunk.collection.aggregate(pipeline).explain('executionStats');
    const cursorStage = explainResult.stages[0].$cursor ?? explainResult.stages[0];

    expect(cursorStage.executionStats.totalDocsExamined).toBe(0);
    expect(JSON.stringify(cursorStage)).toContain(
      '"indexName":"fabFileId_1_embeddingModel_1_retrievalIndexConfirmedModel_1"'
    );
  });
});
