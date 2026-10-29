import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

const makeFabFile = () =>
  FabFile.create({
    userId: 'u1',
    fileName: 'x.png',
    mimeType: 'image/png',
    type: KnowledgeType.FILE,
    filePath: 'x.png',
    status: 'complete',
    moderationStatus: 'clean',
    chunkStallReason: 'rechunkPaused',
  });

const readGated = async (id: unknown) => FabFile.findById(id).select('status moderationStatus chunkStallReason').lean();

const GATED = [
  { path: 'status', valid: 'pending', stored: 'complete' },
  { path: 'moderationStatus', valid: 'scanning', stored: 'clean' },
  { path: 'chunkStallReason', valid: 'vectorizePaused', stored: 'rechunkPaused' },
] as const;

describe('FabFile status enum gate on update', () => {
  describe.each(GATED)('$path', ({ path, valid, stored }) => {
    const writers: Array<[string, (id: unknown, value: unknown) => Promise<unknown>]> = [
      ['updateOne $set', (id, value) => FabFile.updateOne({ _id: id }, { $set: { [path]: value } })],
      ['updateOne top-level', (id, value) => FabFile.updateOne({ _id: id }, { [path]: value })],
      ['updateMany', (id, value) => FabFile.updateMany({ _id: id }, { $set: { [path]: value } })],
      ['findOneAndUpdate', (id, value) => FabFile.findOneAndUpdate({ _id: id }, { $set: { [path]: value } })],
      ['findByIdAndUpdate', (id, value) => FabFile.findByIdAndUpdate(id, { $set: { [path]: value } })],
      ['pipeline literal', (id, value) => FabFile.updateOne({ _id: id }, [{ $set: { [path]: value } }])],
      ['repository update', (id, value) => fabFileRepository.update({ id: String(id), [path]: value })],
    ];

    it.each(writers)('%s rejects an out-of-enum value and leaves the stored value untouched', async (_, write) => {
      const file = await makeFabFile();
      await expect(write(file._id, 'not-a-real-value')).rejects.toThrow(mongoose.Error.ValidationError);
      expect((await readGated(file._id))?.[path]).toBe(stored);
    });

    it.each(writers)('%s accepts an enum value', async (_, write) => {
      const file = await makeFabFile();
      await write(file._id, valid);
      expect((await readGated(file._id))?.[path]).toBe(valid);
    });
  });

  it('lets a pipeline expression through, since its value is only known server-side', async () => {
    const file = await makeFabFile();
    await FabFile.updateOne({ _id: file._id }, [
      { $set: { moderationStatus: { $cond: [true, 'pending', '$moderationStatus'] } } },
    ]);
    expect((await readGated(file._id))?.moderationStatus).toBe('pending');
  });

  it('accepts null for chunkStallReason, the cleared state', async () => {
    const file = await makeFabFile();
    await FabFile.updateOne({ _id: file._id }, { $set: { chunkStallReason: null } });
    expect((await readGated(file._id))?.chunkStallReason).toBeNull();
  });

  it('does not touch updates that leave the gated paths alone', async () => {
    const file = await makeFabFile();
    await FabFile.updateOne({ _id: file._id }, { $set: { notes: 'hello' } });
    expect((await FabFile.findById(file._id).lean())?.notes).toBe('hello');
  });
});
