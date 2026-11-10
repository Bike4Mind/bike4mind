import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Types } from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921240090_unset-fabfile-signed-urls';

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
  await mongoose.connection.dropDatabase();
});

function fabfiles() {
  const db = mongoose.connection.db;
  if (!db) throw new Error('no db connection');
  return db.collection('fabfiles');
}

describe('unset-fabfile-signed-urls migration (real DB)', () => {
  it('unsets the three fields across batches, including soft-deleted rows, and leaves other fields', async () => {
    const count = 2500;
    const docs = Array.from({ length: count }, (_, i) => ({
      _id: new Types.ObjectId(),
      fileName: `f${i}.txt`,
      filePath: `p${i}`,
      fileUrl: 'https://signed.example.invalid/x',
      fileUrlExpireAt: new Date(),
      presignedUrl: 'https://signed.example.invalid/put',
      ...(i % 5 === 0 && { deletedAt: new Date() }),
    }));
    const untouched = { _id: new Types.ObjectId(), fileName: 'clean.txt', filePath: 'clean' };
    await fabfiles().insertMany([...docs, untouched]);
    const partial = { _id: new Types.ObjectId(), fileName: 'partial.txt', fileUrl: 'https://signed.example.invalid/y' };
    await fabfiles().insertOne(partial);

    await migration.up();

    expect(
      await fabfiles().countDocuments({
        $or: [
          { fileUrl: { $exists: true } },
          { fileUrlExpireAt: { $exists: true } },
          { presignedUrl: { $exists: true } },
        ],
      })
    ).toBe(0);
    const sample = await fabfiles().findOne({ _id: docs[0]._id });
    expect(sample).toMatchObject({ fileName: 'f0.txt', filePath: 'p0' });
    expect(sample?.deletedAt).toBeInstanceOf(Date);
    expect(await fabfiles().findOne({ _id: untouched._id })).toEqual(untouched);
    expect(await fabfiles().findOne({ _id: partial._id })).toEqual({ _id: partial._id, fileName: 'partial.txt' });
  });

  it('is a no-op on rerun', async () => {
    const id = new Types.ObjectId();
    await fabfiles().insertOne({ _id: id, fileName: 'a.txt', fileUrl: 'https://signed.example.invalid/x' });
    await migration.up();
    const after = await fabfiles().findOne({ _id: id });
    await migration.up();
    expect(await fabfiles().findOne({ _id: id })).toEqual(after);
  });
});
