import { describe, it, expect } from 'vitest';
import { FabFileChunk } from '../models/content/FabFileModel';
import { setupMongoTest } from '../__test__/utils';

/**
 * The fabfilechunks index set is deliberately minimal: one compound index serves both the keyset
 * chunk walk and every bare `fabFileId` read. Two regressions would undo that silently - a second
 * declaration creeping back onto the schema (autoIndex builds whatever is declared, so it returns
 * on the next cold boot), or the compound itself going away. The plan tests below name the index
 * rather than just asserting "some index scan", because a resurrected `{ fabFileId: 1 }` would
 * satisfy the weaker form while being exactly the thing we do not want back.
 */
describe('fabfilechunks indexes', () => {
  setupMongoTest();

  // schema.indexes() also reports field-level `index: true` / `unique: true`, so this covers the
  // route CLAUDE.md forbids as well as an explicit declaration.
  it('declares exactly one index: the keyset compound', () => {
    expect(FabFileChunk.schema.indexes().map(([key]) => key)).toEqual([{ fabFileId: 1, _id: 1 }]);
  });

  it('builds only the _id index and the keyset compound', async () => {
    await FabFileChunk.createIndexes();

    const names = (await FabFileChunk.collection.indexes()).map(index => index.name).sort();
    expect(names).toEqual(['_id_', 'fabFileId_1__id_1']);
  });

  // Name-derivation contract for the drop migration that still has to remove the two orphans left
  // in already-deployed environments. It cannot fail on a regression in this file's own subject -
  // it builds the legacy indexes itself - so it is documentation of what safeDropIndex must be
  // passed, not a guard on the declared set. Worth pinning because safeDropIndex swallows
  // index-not-found, making a wrong name an invisible no-op.
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
      ['a', 'b', 'c'].flatMap(fabFileId =>
        Array.from({ length: 8 }, (_, i) => ({ fabFileId, text: `${fabFileId}${i}`, tokenCount: 2, vector: [0.1] }))
      )
    );
    await FabFileChunk.createIndexes();

    const plan = await FabFileChunk.collection
      .find({ fabFileId: { $in: ['a', 'b', 'c'] }, vector: { $exists: true, $ne: [] } })
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
      Array.from({ length: 10 }, (_, i) => ({ fabFileId: 'lake', text: `c${i}`, tokenCount: 2, vector: [0.1] }))
    );
    await FabFileChunk.createIndexes();
    const first = await FabFileChunk.collection.find({ fabFileId: 'lake' }).sort({ _id: 1 }).limit(3).toArray();

    const plan = await FabFileChunk.collection
      .find({
        fabFileId: { $in: ['lake'] },
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
    // deleteManyByFabFileId and countTerminalChunks all filter on fabFileId alone and must still
    // get an index scan rather than a collection scan.
    await FabFileChunk.create(
      Array.from({ length: 60 }, (_, i) => ({
        fabFileId: i % 12 === 0 ? 'lake' : 'other',
        text: `chunk ${i}`,
        tokenCount: 2,
      }))
    );
    await FabFileChunk.createIndexes();

    const plan = await FabFileChunk.collection.find({ fabFileId: 'lake' }).explain('queryPlanner');

    // Substring checks on the serialized plan, matching fabFileChunkVectorScope.test.ts: MongoDB's
    // SBE nests the classic plan under winningPlan.queryPlan, so a structural path assertion would
    // break across mongodb-memory-server binary versions.
    const stages = JSON.stringify(plan.queryPlanner.winningPlan);
    expect(stages).toContain('"indexName":"fabFileId_1__id_1"');
    expect(stages).not.toContain('COLLSCAN');
  });
});
