import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType } from '@bike4mind/common';
import { createMongoReplSet } from '../../__test__/createMongoServer';
import { FabFile, FabFileChunk, fabFileRepository, fabFileChunkRepository } from './FabFileModel';

let server: Awaited<ReturnType<typeof createMongoReplSet>>;
beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri());
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 60000);
it('rolls back the file row when chunk deletion fails, then removes both on retry', async () => {
  const file = await FabFile.create({
    userId: 'owner',
    fileName: 'doc.txt',
    filePath: 'doc.txt',
    mimeType: 'text/plain',
    type: KnowledgeType.FILE,
    fileSize: 3,
    status: 'complete',
    deletedAt: new Date(),
  });
  await FabFileChunk.create({ fabFileId: file.id, text: 'abc', tokenCount: 1 });
  const deletion = vi
    .spyOn(fabFileChunkRepository, 'deleteManyByFabFileId')
    .mockRejectedValueOnce(new Error('crash between writes'));
  await expect(fabFileRepository.hardDeleteWithChunks(file.id)).rejects.toThrow('crash between writes');
  expect(await FabFile.collection.findOne({ _id: file._id })).not.toBeNull();
  expect(await FabFileChunk.countDocuments({ fabFileId: file.id })).toBe(1);
  deletion.mockRestore();
  await fabFileRepository.hardDeleteWithChunks(file.id);
  expect(await FabFile.collection.findOne({ _id: file._id })).toBeNull();
  expect(await FabFileChunk.countDocuments({ fabFileId: file.id })).toBe(0);
  await expect(fabFileRepository.hardDeleteWithChunks(file.id)).resolves.toBeUndefined();
});
