import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import {
  orgAdminNotificationPrefRepository as repo,
  OrgAdminNotificationPrefModel,
} from './OrgAdminNotificationPrefModel';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { User } from '../../auth/UserModel';
import { createMongoReplSet, MONGO_TEST_TIMEOUT_MS, settleAutoIndexBuilds } from '../../../__test__/createMongoServer';
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let replica: MongoMemoryReplSet;
beforeAll(async () => {
  replica = await createMongoReplSet();
  await mongoose.connect(replica.getUri());
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await replica.stop();
});

describe('OrgAdminNotificationPrefRepository', () => {
  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    await User.collection.insertMany([
      { _id: new mongoose.Types.ObjectId('abcdef100000000000000001') },
      { _id: new mongoose.Types.ObjectId('abcdef100000000000000002') },
    ]);
    await OrgAdminNotificationPrefModel.ensureIndexes();
  });

  it('creates one row per (org, user) and merges later partial updates', async () => {
    await repo.upsertForUser('abcdef000000000000000001', 'abcdef100000000000000001', { low_balance: true });
    await repo.upsertForUser('abcdef000000000000000001', 'abcdef100000000000000001', { low_balance: true });
    const merged = await repo.upsertForUser('abcdef000000000000000001', 'abcdef100000000000000001', {
      seat_limit: false,
    });

    expect(await OrgAdminNotificationPrefModel.countDocuments({})).toBe(1);
    expect(merged?.kinds).toEqual({ low_balance: true, seat_limit: false });
  });

  it('leaves unset kinds absent so the role default applies', async () => {
    await repo.upsertForUser('abcdef000000000000000001', 'abcdef100000000000000001', { low_balance: false });

    const row = await repo.getForUser('abcdef000000000000000001', 'abcdef100000000000000001');
    expect(row?.kinds.low_balance).toBe(false);
    expect(row?.kinds.budget_threshold).toBeUndefined();
  });

  it('getForOrg returns only that org', async () => {
    await repo.upsertForUser('abcdef000000000000000001', 'abcdef100000000000000001', { low_balance: true });
    await repo.upsertForUser('abcdef000000000000000001', 'abcdef100000000000000002', { low_balance: true });
    await repo.upsertForUser('abcdef000000000000000002', 'abcdef100000000000000001', { low_balance: true });

    expect((await repo.getForOrg('abcdef000000000000000001')).map(r => r.userId).sort()).toEqual([
      'abcdef100000000000000001',
      'abcdef100000000000000002',
    ]);
  });
});
