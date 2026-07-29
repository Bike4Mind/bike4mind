import { describe, it, expect } from 'vitest';
import { FabFileChunk } from '../models/content/FabFileModel';
import { setupMongoTest } from '../__test__/utils';

/**
 * The fabfilechunks index set is deliberately minimal: one compound index serves both the keyset
 * chunk walk and every bare `fabFileId` read. Two regressions would undo that silently - a second
 * declaration creeping back onto the schema (autoIndex builds whatever is declared, so it returns
 * on the next cold boot), or the compound itself going away.
 *
 * The legacy-name test also pins the literals a follow-up drop migration has to pass to
 * safeDropIndex, which swallows index-not-found and would therefore no-op invisibly on a typo.
 */
describe('fabfilechunks indexes', () => {
  setupMongoTest();

  it('declares exactly one index: the keyset compound', () => {
    expect(FabFileChunk.schema.indexes().map(([key]) => key)).toEqual([{ fabFileId: 1, _id: 1 }]);
  });

  it('builds only the _id index and the keyset compound', async () => {
    await FabFileChunk.createIndexes();

    const names = (await FabFileChunk.collection.indexes()).map(index => index.name).sort();
    expect(names).toEqual(['_id_', 'fabFileId_1__id_1']);
  });

  it('names the legacy key patterns the way a drop migration must reference them', async () => {
    // Both legacy indexes were built by autoIndex from schema declarations, i.e. with no explicit
    // name, so what mongo derives here is exactly what a drop has to name.
    await FabFileChunk.createIndexes();
    await FabFileChunk.collection.createIndex({ _id: 1, fabFileId: 1 });
    await FabFileChunk.collection.createIndex({ fabFileId: 1 });

    const names = (await FabFileChunk.collection.indexes()).map(index => index.name).sort();
    expect(names).toEqual(['_id_', '_id_1_fabFileId_1', 'fabFileId_1', 'fabFileId_1__id_1']);
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
