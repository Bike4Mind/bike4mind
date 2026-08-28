import { describe, it, expect, beforeEach } from 'vitest';
import { FabFile, FabFileChunk, fabFileChunkRepository } from '../models/content/FabFileModel';
import { setupMongoTest } from '../__test__/utils';

/**
 * DB half of the stranded-vectorize rescue. A file whose chunks committed but whose vectorize
 * hand-off failed has chunks and no vectors, which makes it invisible to the un-chunked sweep
 * (that one requires chunkCount: 0). Two things have to hold for the recovery to work at all:
 * the resume set must be exactly the chunks still lacking a vector, and the sweep's filter must
 * be served by an index rather than a collection scan.
 */
describe('stranded vectorize hand-off recovery', () => {
  setupMongoTest();

  beforeEach(async () => {
    await FabFileChunk.deleteMany({});
    await FabFile.deleteMany({});
  });

  describe('findVectorlessChunkIds', () => {
    it('returns only chunks of the requested file that hold no vector', async () => {
      // A half-finished fan-out is the interesting case: some batches landed, some never sent.
      const created = await FabFileChunk.create([
        { fabFileId: 'stranded', text: 'vectorized', tokenCount: 2, vector: [0.1, 0.2] },
        { fabFileId: 'stranded', text: 'empty vector', tokenCount: 2, vector: [] },
        { fabFileId: 'stranded', text: 'no vector field', tokenCount: 2 },
        { fabFileId: 'other-file', text: 'not ours', tokenCount: 2 },
      ]);

      const ids = await fabFileChunkRepository.findVectorlessChunkIds('stranded');

      const expected = created
        .filter(c => ['empty vector', 'no vector field'].includes(c.text))
        .map(c => String(c._id));
      expect(ids.sort()).toEqual(expected.sort());
    });

    it('returns nothing for a file whose fan-out fully completed', async () => {
      await FabFileChunk.create([
        { fabFileId: 'done', text: 'a', tokenCount: 2, vector: [0.1] },
        { fabFileId: 'done', text: 'b', tokenCount: 2, vector: [0.2] },
      ]);

      expect(await fabFileChunkRepository.findVectorlessChunkIds('done')).toEqual([]);
    });
  });

  describe('vectorizeEnqueueFailedAt index', () => {
    it('is partial, so it holds only the stamped files', async () => {
      const [declared] = FabFile.schema.indexes().filter(([key]) => 'vectorizeEnqueueFailedAt' in key);
      expect(declared[1]?.partialFilterExpression).toEqual({ vectorizeEnqueueFailedAt: { $type: 'date' } });
    });

    it('serves the rescue sweep from that index instead of scanning the collection', async () => {
      // The sweep runs on a schedule and finds nothing almost every time, so a collection scan
      // here would cost a full pass over every file in the lake per cycle.
      await FabFile.create([
        {
          userId: 'u1',
          fileName: 'stranded.pdf',
          type: 'FILE',
          chunked: true,
          vectorizeEnqueueFailedAt: new Date('2026-01-01'),
        },
        { userId: 'u1', fileName: 'healthy.pdf', type: 'FILE', chunked: true },
      ]);
      await FabFile.createIndexes();

      const plan = await FabFile.collection
        .find({ vectorizeEnqueueFailedAt: { $lt: new Date('2026-02-01') }, isChunking: { $ne: true }, deletedAt: null })
        .explain('queryPlanner');

      const winning = JSON.stringify(plan.queryPlanner.winningPlan);
      expect(winning).toContain('IXSCAN');
      expect(winning).toContain('vectorizeEnqueueFailedAt');
      expect(winning).not.toContain('"stage":"COLLSCAN"');
    });

    it('still uses the index when the sweep carries its stale-claim $or', async () => {
      // The stale-claim recovery arm (buildStrandedVectorizeScanFilter) adds a three-way $or on
      // isChunking, which is exactly the shape that can tip the planner into subplanning and a
      // collection scan. The stamp predicate has to stay the one leading the plan.
      await FabFile.create([
        {
          userId: 'u1',
          fileName: 'stranded.pdf',
          type: 'FILE',
          chunked: true,
          vectorizeEnqueueFailedAt: new Date('2026-01-01'),
        },
        { userId: 'u1', fileName: 'healthy.pdf', type: 'FILE', chunked: true },
      ]);
      await FabFile.createIndexes();

      const plan = await FabFile.collection
        .find({
          vectorizeEnqueueFailedAt: { $type: 'date', $lt: new Date('2026-02-01') },
          chunked: true,
          deletedAt: null,
          $or: [
            { isChunking: { $ne: true } },
            { isChunking: true, chunkClaimedAt: { $lt: new Date('2026-01-15') } },
            { isChunking: true, chunkClaimedAt: null },
          ],
        })
        .explain('queryPlanner');

      const winning = JSON.stringify(plan.queryPlanner.winningPlan);
      expect(winning).toContain('IXSCAN');
      expect(winning).toContain('vectorizeEnqueueFailedAt');
      expect(winning).not.toContain('"stage":"COLLSCAN"');
    });

    it('rescues a file whose claim went stale, and leaves a live claim alone', async () => {
      // The failure the arm exists for: a worker hard-killed inside resumeVectorizeEnqueue leaves
      // isChunking:true with nothing to clear it, and no other automatic door selects the file.
      const staleClaimBefore = new Date('2026-01-15');
      await FabFile.create([
        {
          userId: 'u1',
          fileName: 'stale-claim.pdf',
          type: 'FILE',
          chunked: true,
          isChunking: true,
          chunkClaimedAt: new Date('2026-01-01'),
          vectorizeEnqueueFailedAt: new Date('2026-01-01'),
        },
        {
          userId: 'u1',
          fileName: 'in-flight.pdf',
          type: 'FILE',
          chunked: true,
          isChunking: true,
          chunkClaimedAt: new Date('2026-01-20'),
          vectorizeEnqueueFailedAt: new Date('2026-01-01'),
        },
      ]);

      const selected = await FabFile.collection
        .find({
          vectorizeEnqueueFailedAt: { $type: 'date', $lt: new Date('2026-02-01') },
          chunked: true,
          deletedAt: null,
          $or: [
            { isChunking: { $ne: true } },
            { isChunking: true, chunkClaimedAt: { $lt: staleClaimBefore } },
            { isChunking: true, chunkClaimedAt: null },
          ],
        })
        .toArray();

      expect(selected.map(f => f.fileName)).toEqual(['stale-claim.pdf']);
    });

    it('selects the stamped file only, never the unstamped default', async () => {
      // The field defaults to null on every file, and null sorts BEFORE any date. What keeps the
      // sweep from selecting the whole collection is that $lt matches within a BSON type bracket
      // only, so null is out of range - which is also why the partial index stays usable here.
      await FabFile.create([
        {
          userId: 'u1',
          fileName: 'stranded.pdf',
          type: 'FILE',
          chunked: true,
          vectorizeEnqueueFailedAt: new Date('2026-01-01'),
        },
        { userId: 'u1', fileName: 'healthy.pdf', type: 'FILE', chunked: true },
      ]);

      const selected = await FabFile.collection
        .find({ vectorizeEnqueueFailedAt: { $lt: new Date('2026-02-01') }, isChunking: { $ne: true }, deletedAt: null })
        .toArray();

      expect(selected.map(f => f.fileName)).toEqual(['stranded.pdf']);
    });
  });
});
