import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType } from '@bike4mind/common';
import { createMongoReplSet } from '../../__test__/createMongoServer';
import { FabFile, FabFileChunk, fabFileRepository } from './FabFileModel';

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
  const deletion = vi.spyOn(FabFileChunk, 'deleteMany').mockImplementationOnce(() => {
    throw new Error('crash between writes');
  });
  await expect(fabFileRepository.hardDeleteWithChunks(file.id)).rejects.toThrow('crash between writes');
  expect(await FabFile.collection.findOne({ _id: file._id })).not.toBeNull();
  expect(await FabFileChunk.countDocuments({ fabFileId: file.id })).toBe(1);
  deletion.mockRestore();
  await fabFileRepository.hardDeleteWithChunks(file.id);
  expect(await FabFile.collection.findOne({ _id: file._id })).toBeNull();
  expect(await FabFileChunk.countDocuments({ fabFileId: file.id })).toBe(0);
  await expect(fabFileRepository.hardDeleteWithChunks(file.id)).resolves.toBeUndefined();
});

it('bounds chunk batches, retains the retry locator after partial progress, and preserves other files', async () => {
  const file = await FabFile.create({
    userId: 'owner',
    fileName: 'large.txt',
    filePath: 'large.txt',
    mimeType: 'text/plain',
    type: KnowledgeType.FILE,
    fileSize: 7,
    status: 'complete',
    deletedAt: new Date(),
  });
  const otherId = new mongoose.Types.ObjectId().toString();
  await FabFileChunk.insertMany([
    ...Array.from({ length: 7 }, (_, i) => ({ fabFileId: file.id, text: `chunk-${i}`, tokenCount: 1 })),
    { fabFileId: otherId, text: 'unrelated', tokenCount: 1 },
  ]);
  const original = FabFileChunk.deleteMany.bind(FabFileChunk);
  let calls = 0;
  const deletion = vi.spyOn(FabFileChunk, 'deleteMany').mockImplementation((...args) => {
    calls++;
    if (calls === 2) throw new Error('later batch failed');
    return original(...args);
  });
  await expect(fabFileRepository.hardDeleteWithChunks(file.id, 2)).rejects.toThrow('later batch failed');
  expect(await FabFile.collection.findOne({ _id: file._id })).not.toBeNull();
  expect(await FabFileChunk.countDocuments({ fabFileId: file.id })).toBe(5);
  deletion.mockRestore();
  const observed = vi.spyOn(FabFileChunk, 'deleteMany');
  await fabFileRepository.hardDeleteWithChunks(file.id, 2);
  expect(await FabFile.collection.findOne({ _id: file._id })).toBeNull();
  expect(await FabFileChunk.countDocuments({ fabFileId: file.id })).toBe(0);
  expect(await FabFileChunk.countDocuments({ fabFileId: otherId })).toBe(1);
  expect(
    observed.mock.calls.every(([filter]) => filter && Array.isArray(filter._id?.$in) && filter._id.$in.length <= 2)
  ).toBe(true);
  observed.mockRestore();
});

it('includes chunks committed after candidate selection but before the final transaction', async () => {
  const file = await FabFile.create({
    userId: 'owner',
    fileName: 'race.txt',
    filePath: 'race.txt',
    mimeType: 'text/plain',
    type: KnowledgeType.FILE,
    fileSize: 3,
    status: 'complete',
    deletedAt: new Date(),
  });
  await FabFileChunk.create({ fabFileId: file.id, text: 'initial', tokenCount: 1 });
  const original = mongoose.connection.transaction.bind(mongoose.connection);
  const transaction = vi.spyOn(mongoose.connection, 'transaction').mockImplementationOnce(async (...args) => {
    await FabFileChunk.create({ fabFileId: file.id, text: 'late', tokenCount: 1 });
    return original(...args);
  });
  try {
    await fabFileRepository.hardDeleteWithChunks(file.id, 1);
    expect(await FabFile.collection.findOne({ _id: file._id })).toBeNull();
    expect(await FabFileChunk.countDocuments({ fabFileId: file.id })).toBe(0);
  } finally {
    transaction.mockRestore();
  }
});

it.each([0, 1001, 1.5, NaN])('rejects invalid batch size %s before database writes', async size => {
  const deletion = vi.spyOn(FabFileChunk, 'deleteMany');
  try {
    await expect(
      fabFileRepository.hardDeleteWithChunks(new mongoose.Types.ObjectId().toString(), size)
    ).rejects.toThrow('batch size');
    expect(deletion).not.toHaveBeenCalled();
  } finally {
    deletion.mockRestore();
  }
});
