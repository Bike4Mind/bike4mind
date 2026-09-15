import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { FabFile, fabFileRepository } from './FabFileModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await FabFile.deleteMany({});
});

// Source for the background AI-taxonomy analysis job: given a batchId, pull every
// file that landed in it so the job can sample folder structure/names post-upload.
describe('FabFileRepository.findByBatchId', () => {
  const userId = 'u-batch';

  it('returns only non-deleted files stamped with the given batchId', async () => {
    await FabFile.create({
      userId,
      fileName: 'a.txt',
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      filePath: 'a.txt',
      batchId: 'batch-1',
    });
    await FabFile.create({
      userId,
      fileName: 'b.txt',
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      filePath: 'b.txt',
      batchId: 'batch-2', // different batch -> excluded
    });
    const deleted = await FabFile.create({
      userId,
      fileName: 'deleted.txt',
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      filePath: 'deleted.txt',
      batchId: 'batch-1',
    });
    await FabFile.updateOne({ _id: deleted._id }, { $set: { deletedAt: new Date() } });

    const files = await fabFileRepository.findByBatchId('batch-1');
    expect(files.map(f => f.fileName)).toEqual(['a.txt']);
  });

  it('returns an empty array for a batch with no files', async () => {
    const files = await fabFileRepository.findByBatchId('no-such-batch');
    expect(files).toEqual([]);
  });
});
