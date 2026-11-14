import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import type { ClaimOrgAlertInput } from '@bike4mind/common';
import { orgAlertNotificationRepository as repo, OrgAlertNotificationModel } from './OrgAlertNotificationModel';
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

const input = (overrides: Partial<ClaimOrgAlertInput> = {}): ClaimOrgAlertInput => ({
  organizationId: 'abcdef000000000000000001',
  kind: 'budget_threshold',
  scope: 'pct:80',
  periodKey: '2026-11',
  ...overrides,
});

describe('OrgAlertNotificationRepository', () => {
  // setupMongoTest drops the database (indexes included) before each test.
  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    await User.collection.insertMany([
      { _id: new mongoose.Types.ObjectId('abcdef100000000000000001') },
      { _id: new mongoose.Types.ObjectId('abcdef100000000000000002') },
    ]);
    await OrgAlertNotificationModel.ensureIndexes();
  });

  it('claims once per (organizationId, kind, scope, periodKey)', async () => {
    const first = await repo.claim(input());
    const second = await repo.claim(input());

    expect(first.claimed).toBe(true);
    expect(first.id).toBeDefined();
    expect(second).toEqual({ claimed: false });
    const docs = await OrgAlertNotificationModel.find({});
    expect(docs).toHaveLength(1);
    expect(String(docs[0]._id)).toBe(first.id);
    expect(docs[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('lets exactly one of many concurrent claimers win', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => repo.claim(input())));

    expect(results.filter(r => r.claimed)).toHaveLength(1);
    expect(await OrgAlertNotificationModel.countDocuments({})).toBe(1);
  });

  it('treats a new scope or period as a separate slot', async () => {
    await repo.claim(input());

    expect((await repo.claim(input({ scope: 'pct:90' }))).claimed).toBe(true);
    expect((await repo.claim(input({ periodKey: '2026-12' }))).claimed).toBe(true);
    expect((await repo.claim(input({ organizationId: 'abcdef000000000000000002' }))).claimed).toBe(true);
  });

  it('release re-opens the slot', async () => {
    const first = await repo.claim(input());
    await repo.release(first.id!);

    expect((await repo.claim(input())).claimed).toBe(true);
  });

  it('records the subject user on a per-person alert', async () => {
    await repo.claim(
      input({ kind: 'member_cap', scope: 'user:abcdef100000000000000001', subjectUserId: 'abcdef100000000000000001' })
    );

    expect((await OrgAlertNotificationModel.findOne({ kind: 'member_cap' }))?.subjectUserId).toBe(
      'abcdef100000000000000001'
    );
  });
});
