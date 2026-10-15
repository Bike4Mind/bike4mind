import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { StorageDriftRecord, storageDriftRecordRepository } from './StorageDriftRecordModel';

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
  await StorageDriftRecord.deleteMany({});
});

const record = (userId: string, counter: number, truth: number, checkedAt: Date) => ({
  userId,
  counter,
  truth,
  drift: counter - truth,
  repaired: false,
  conflict: false,
  checkedAt,
});

describe('StorageDriftRecordRepository.latestByUserIds', () => {
  const older = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const newer = new Date(Date.now() - 24 * 60 * 60 * 1000);

  it('returns the newest record per user and omits users never checked', async () => {
    await storageDriftRecordRepository.appendMany([
      record('u1', 1000, 400, older),
      record('u1', 1000, 500, newer),
      record('u2', 250, 250, newer),
    ]);

    const latest = await storageDriftRecordRepository.latestByUserIds(['u1', 'u2', 'u3']);

    expect(latest.get('u1')?.truth).toBe(500);
    expect(latest.get('u2')?.truth).toBe(250);
    expect(latest.has('u3')).toBe(false);
    expect(latest.size).toBe(2);
  });

  it('returns an empty map for an empty input', async () => {
    expect((await storageDriftRecordRepository.latestByUserIds([])).size).toBe(0);
  });
});

describe('StorageDriftRecordRepository.appendMany', () => {
  it('inserts nothing for an empty input', async () => {
    await storageDriftRecordRepository.appendMany([]);
    expect(await StorageDriftRecord.countDocuments({})).toBe(0);
  });
});
