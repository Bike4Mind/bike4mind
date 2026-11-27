import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { FabFile, fabFileRepository } from './FabFileModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { autoIndex: false });
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

describe('FabFileRepository grant cleanup discovery', () => {
  it('finds detached tombstones without exposing them through normal ID reads', async () => {
    const id = new mongoose.Types.ObjectId();
    const deletedAt = new Date('2026-01-01');
    const sessionId = '0123456789abcdef01234567';
    await FabFile.collection.insertOne({
      _id: id,
      userId: 'owner',
      fileName: 'notes.txt',
      mimeType: 'text/plain',
      deletedAt,
      archivedAt: null,
      __v: 3,
      users: [{ userId: 'reader', permissions: ['read', 'share'], sessionId: sessionId.toUpperCase() }],
      groups: [],
    });

    expect(await fabFileRepository.findAllByIds([String(id)])).toEqual([]);
    const byId = await fabFileRepository.findAllByIds([String(id)], { includeDeleted: true });
    const bySource = await fabFileRepository.findSharingGrantFilesBySession(sessionId, 'reader');
    expect(byId).toHaveLength(1);
    expect(bySource).toHaveLength(1);
    expect(bySource[0].id).toBe(String(id));
    expect(bySource[0].users).toEqual(byId[0].users);
    expect(bySource[0].deletedAt).toEqual(deletedAt);
    expect(bySource[0]).toHaveProperty('__v', 3);
    expect(await fabFileRepository.findSharingGrantFilesBySession(sessionId, 'other')).toEqual([]);
    expect((await FabFile.collection.findOne({ _id: id }))?.deletedAt).toEqual(deletedAt);
  });
});
