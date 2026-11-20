import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { ErasureRecordModel, erasureRecordRepository, type IErasureRecord } from './ErasureRecordModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await ErasureRecordModel.init();
}, MONGO_TEST_TIMEOUT_MS);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await ErasureRecordModel.deleteMany({});
});

const rec = (over: Partial<IErasureRecord> = {}): IErasureRecord => ({
  idHash: 'h1',
  keyId: 'k1',
  pseudonym: null,
  erasedAt: new Date('2026-01-01T00:00:00Z'),
  initiatedBy: 'self',
  ...over,
});

describe('ErasureRecordModel', () => {
  it('keeps the first record when the same idHash is recorded again', async () => {
    await erasureRecordRepository.record(rec());
    await erasureRecordRepository.record(rec({ erasedAt: new Date('2027-01-01T00:00:00Z'), initiatedBy: 'admin' }));
    const all = await ErasureRecordModel.find().lean();
    expect(all).toHaveLength(1);
    expect(all[0].erasedAt).toEqual(new Date('2026-01-01T00:00:00Z'));
    expect(all[0].initiatedBy).toBe('self');
  });

  it('has a unique idHash index and no TTL index', async () => {
    const indexes = await ErasureRecordModel.collection.indexes();
    expect(indexes.some(i => i.key.idHash === 1 && i.unique)).toBe(true);
    expect(indexes.some(i => i.expireAfterSeconds !== undefined)).toBe(false);
  });

  it('imports only new records and streams all of them in erasure order', async () => {
    await erasureRecordRepository.record(rec({ idHash: 'b', erasedAt: new Date('2026-02-01T00:00:00Z') }));
    const added = await erasureRecordRepository.importMany([
      rec({ idHash: 'b' }),
      rec({ idHash: 'a', erasedAt: new Date('2026-01-01T00:00:00Z') }),
    ]);
    expect(added).toBe(1);
    const out: string[] = [];
    for await (const r of erasureRecordRepository.cursor()) out.push(r.idHash);
    expect(out).toEqual(['a', 'b']);
  });
});
