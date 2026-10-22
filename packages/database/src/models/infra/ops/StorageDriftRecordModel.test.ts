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
    // Newer first: a query that drops $sort and keeps insertion order ($last) then fails. u9 is not
    // requested, which pins the $match.
    await storageDriftRecordRepository.appendMany([
      record('u1', 1000, 500, newer),
      record('u1', 1000, 400, older),
      record('u2', 250, 250, newer),
      record('u9', 900, 100, newer),
    ]);

    const latest = await storageDriftRecordRepository.latestByUserIds(['u1', 'u2', 'u3']);

    expect(latest.get('u1')?.truth).toBe(500);
    expect(latest.get('u2')?.truth).toBe(250);
    expect(latest.has('u3')).toBe(false);
    expect(latest.has('u9')).toBe(false);
    expect(latest.size).toBe(2);
  });

  it('returns an empty map for an empty input', async () => {
    expect((await storageDriftRecordRepository.latestByUserIds([])).size).toBe(0);
  });
});

describe('StorageDriftRecordRepository.latestByOrganizationIds', () => {
  const older = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const newer = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const orgRecord = (organizationId: string, truth: number, checkedAt: Date) => ({
    ...record('', 1000, truth, checkedAt),
    userId: undefined,
    organizationId,
  });

  it('returns the newest record per organization and ignores user records', async () => {
    await storageDriftRecordRepository.appendMany([
      orgRecord('o1', 500, newer),
      orgRecord('o1', 400, older),
      orgRecord('o9', 100, newer),
      record('o1', 1000, 1, newer),
    ]);

    const latest = await storageDriftRecordRepository.latestByOrganizationIds(['o1', 'o2']);

    expect(latest.get('o1')?.truth).toBe(500);
    expect(latest.has('o2')).toBe(false);
    expect(latest.size).toBe(1);
  });

  it('returns an empty map for an empty input', async () => {
    expect((await storageDriftRecordRepository.latestByOrganizationIds([])).size).toBe(0);
  });
});

describe('StorageDriftRecord owner validation', () => {
  const base = { counter: 1, truth: 1, drift: 0, repaired: false, conflict: false, checkedAt: new Date() };

  it.each([
    ['neither owner', {}],
    ['both owners', { userId: 'u1', organizationId: 'o1' }],
  ])('rejects a record with %s', async (_label, owner) => {
    await expect(storageDriftRecordRepository.appendMany([{ ...base, ...owner }])).rejects.toThrow();
  });
});

describe('StorageDriftRecordRepository.appendMany', () => {
  it('inserts nothing for an empty input', async () => {
    await storageDriftRecordRepository.appendMany([]);
    expect(await StorageDriftRecord.countDocuments({})).toBe(0);
  });
});
