import { describe, it, expect, beforeEach } from 'vitest';
import { FabFile } from '../models/content/FabFileModel';
import { setupMongoTest } from '../__test__/utils';
import { KnowledgeType } from '@bike4mind/common';

/**
 * DB half of the moderation rescue sweep (apps/client/server/s3/moderationRescueSweep.ts). The
 * sweep runs both of its queries every 60s on the self-host worker, so neither may be a collection
 * scan, and its fairness ordering only works if the index can supply the sort. Everything asserted
 * here is a property of the schema's index, which lives in this package - the sweep's own behaviour
 * is covered by moderationRescueSweep.test.ts / .e2e.test.ts next to it.
 */
describe('moderation rescue sweep index', () => {
  setupMongoTest();

  const STALE_CUTOFF = new Date('2026-01-01T00:00:00Z');
  const RETRY_AFTER = new Date('2026-01-01T00:00:00Z');

  // Mirrors the sweep's stale-'pending' selection.
  const selectionFilter = {
    moderationStatus: 'pending',
    deletedAt: null,
    createdAt: { $lt: STALE_CUTOFF },
    filePath: { $exists: true, $ne: '' },
    $and: [
      { $or: [{ filePath: /^knowledge\// }, { status: 'complete' }] },
      { $or: [{ moderationLastAttemptAt: null }, { moderationLastAttemptAt: { $lt: RETRY_AFTER } }] },
    ],
  };

  // Mirrors the sweep's stale-'scanning' reclaim.
  const reclaimFilter = {
    moderationStatus: 'scanning',
    deletedAt: null,
    $or: [
      { moderationClaimedAt: { $lt: STALE_CUTOFF } },
      { moderationClaimedAt: { $exists: false }, updatedAt: { $lt: STALE_CUTOFF } },
    ],
  };

  const SWEEP_INDEX = 'moderationStatus_1_deletedAt_1_moderationAttempts_1_createdAt_1';

  beforeEach(async () => {
    await FabFile.deleteMany({});
    // Load-bearing volume, not padding: on a handful of documents every index costs the same and
    // the planner picks arbitrarily, so a COLLSCAN assertion cannot fail. These are 'clean' - i.e.
    // outside both sweep filters - which is what makes seeking the moderationStatus prefix the only
    // cheap plan. Raw driver: Mongoose would run the softDeletePlugin hooks and timestamps per doc.
    await FabFile.collection.insertMany(
      Array.from({ length: 2000 }, (_, i) => ({
        userId: 'u1',
        fileName: `decoy-${i}.png`,
        type: KnowledgeType.FILE,
        filePath: `${i}-decoy.png`,
        status: 'complete',
        moderationStatus: 'clean',
        deletedAt: null,
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      }))
    );
    await FabFile.createIndexes();
  });

  it('declares the sweep index with moderationAttempts ahead of createdAt', async () => {
    // Order is the whole point: the equality prefix seeks, moderationAttempts then SUPPLIES the
    // selection's fairness sort so the planner can stream in sort order and stop at `limit`
    // instead of a blocking top-K over every pending row. createdAt trails as the tiebreaker.
    const declared = FabFile.schema.indexes().find(([key]) => 'moderationAttempts' in key)?.[0];
    expect(Object.keys(declared ?? {})).toEqual(['moderationStatus', 'deletedAt', 'moderationAttempts', 'createdAt']);
  });

  it('serves the stale-pending selection from the index rather than scanning the collection', async () => {
    const plan = await FabFile.collection.find(selectionFilter).explain('queryPlanner');
    const winning = JSON.stringify(plan.queryPlanner.winningPlan);

    // The index NAME, not a field name: every field appears in some plan's residual FETCH filter,
    // so a bare substring check on one passes even when another index won.
    expect(winning).toContain(`"indexName":"${SWEEP_INDEX}"`);
    expect(winning).not.toContain('"stage":"COLLSCAN"');
  });

  it('supplies the fairness sort from the index, so there is no blocking in-memory SORT', async () => {
    const plan = await FabFile.collection
      .find(selectionFilter)
      .sort({ moderationAttempts: 1, createdAt: 1 })
      .limit(200)
      .explain('queryPlanner');
    const winning = JSON.stringify(plan.queryPlanner.winningPlan);

    expect(winning).toContain(`"indexName":"${SWEEP_INDEX}"`);
    expect(winning).not.toContain('"stage":"COLLSCAN"');
    // A blocking SORT stage would mean the planner buffered every matching pending row before
    // applying the limit - the cost the key order exists to avoid.
    expect(winning).not.toContain('"stage":"SORT"');
  });

  it('serves the stale-scanning reclaim too, despite its $exists-negation $or', async () => {
    // The reclaim's $or has an $exists:false arm, which is the shape that can tip the planner into
    // subplanning and a collection scan. The moderationStatus equality has to stay leading.
    const plan = await FabFile.collection.find(reclaimFilter).explain('queryPlanner');
    const winning = JSON.stringify(plan.queryPlanner.winningPlan);

    expect(winning).toContain(`"indexName":"${SWEEP_INDEX}"`);
    expect(winning).not.toContain('"stage":"COLLSCAN"');
  });

  it('orders a never-attempted row ahead of every repeatedly-failing sibling', async () => {
    // The starvation guarantee, at the DB level: an unset moderationAttempts sorts before any
    // number, so a bounded window always reaches the stranded row no matter how many failing
    // siblings precede it in natural (insertion) order.
    const failing = Array.from({ length: 5 }, (_, i) => ({
      userId: 'u1',
      fileName: `failing-${i}.png`,
      type: KnowledgeType.FILE,
      filePath: `knowledge/u1/failing-${i}`,
      moderationStatus: 'pending',
      moderationAttempts: 7,
      deletedAt: null,
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-01'),
    }));
    await FabFile.collection.insertMany([
      ...failing,
      {
        userId: 'u1',
        fileName: 'stranded.png',
        type: KnowledgeType.FILE,
        filePath: 'knowledge/u1/stranded',
        moderationStatus: 'pending',
        deletedAt: null,
        createdAt: new Date('2025-06-01'), // NEWER than every sibling, so createdAt alone loses
        updatedAt: new Date('2025-06-01'),
      },
    ]);

    const selected = await FabFile.collection
      .find(selectionFilter)
      .sort({ moderationAttempts: 1, createdAt: 1 })
      .limit(1)
      .toArray();

    expect(selected.map(f => f.fileName)).toEqual(['stranded.png']);
  });

  it('holds a just-failed row out of the selection for the backoff window', async () => {
    await FabFile.collection.insertMany([
      {
        userId: 'u1',
        fileName: 'backed-off.png',
        type: KnowledgeType.FILE,
        filePath: 'knowledge/u1/backed-off',
        moderationStatus: 'pending',
        moderationAttempts: 1,
        moderationLastAttemptAt: new Date('2026-02-01'), // after RETRY_AFTER: still backing off
        deletedAt: null,
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      },
      {
        userId: 'u1',
        fileName: 'eligible-again.png',
        type: KnowledgeType.FILE,
        filePath: 'knowledge/u1/eligible-again',
        moderationStatus: 'pending',
        moderationAttempts: 1,
        moderationLastAttemptAt: new Date('2025-12-01'), // before RETRY_AFTER: window elapsed
        deletedAt: null,
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      },
    ]);

    const selected = await FabFile.collection.find(selectionFilter).toArray();

    expect(selected.map(f => f.fileName)).toEqual(['eligible-again.png']);
  });
});
