import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { GrantPackage, RegistrationInvite } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921237500_grant-packages-from-invites';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

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
  await RegistrationInvite.collection.deleteMany({});
  await GrantPackage.collection.deleteMany({});
});

const seed = async (code: string, fields: Record<string, unknown>) => {
  await RegistrationInvite.collection.insertOne({
    code,
    userId: 'admin-1',
    status: 'open',
    usageHistory: [],
    ...fields,
  });
};

const invite = (code: string) => RegistrationInvite.collection.findOne({ code });

describe('grant-packages-from-invites migration', () => {
  it('links one uncapped package per distinct amount pair and leaves invite amounts unchanged', async () => {
    await seed('single', { startingCredits: 500, startingStorage: 1000 });
    await seed('unlimited', { startingCredits: 500, startingStorage: 1000, unlimitedUse: true });
    await seed('subscriber', { email: 'jane@example.test', startingCredits: 100 });
    await seed('storage-only', { startingCredits: 0, startingStorage: 50 });

    await migration.up();

    const packages = await GrantPackage.find().lean();
    expect(packages.map(p => [p.name, p.credits, p.storageMb, p.totalCap, p.dailyCap, p.active]).sort()).toEqual(
      [
        ['Legacy: 0 credits, 50 MB', 0, 50, null, null, true],
        ['Legacy: 100 credits', 100, null, null, null, true],
        ['Legacy: 500 credits, 1000 MB', 500, 1000, null, null, true],
      ].sort()
    );
    const byName = new Map(packages.map(p => [p.name, String(p._id)]));

    const single = await invite('single');
    const unlimited = await invite('unlimited');
    expect(single?.grantPackageId).toBe(byName.get('Legacy: 500 credits, 1000 MB'));
    expect(unlimited?.grantPackageId).toBe(single?.grantPackageId);
    expect(single).toMatchObject({ startingCredits: 500, startingStorage: 1000 });
    expect((await invite('subscriber'))?.grantPackageId).toBe(byName.get('Legacy: 100 credits'));
    expect((await invite('storage-only'))?.grantPackageId).toBe(byName.get('Legacy: 0 credits, 50 MB'));
  });

  it('skips referral invites, invites without amounts, and invites already on a package', async () => {
    await seed('referral', { source: 'referral', startingCredits: 500 });
    await seed('plain', {});
    await seed('zero', { startingCredits: 0 });
    await seed('linked', { startingCredits: 500, grantPackageId: 'existing' });

    await migration.up();

    expect(await GrantPackage.countDocuments()).toBe(0);
    expect((await invite('referral'))?.grantPackageId).toBeUndefined();
    expect((await invite('plain'))?.grantPackageId).toBeUndefined();
    expect((await invite('zero'))?.grantPackageId).toBeUndefined();
    expect((await invite('linked'))?.grantPackageId).toBe('existing');
  });

  it('is idempotent: a re-run creates no package and relinks nothing', async () => {
    await seed('a', { startingCredits: 500 });
    await migration.up();
    const first = await invite('a');

    await seed('b', { startingCredits: 500 });
    await migration.up();

    expect(await GrantPackage.countDocuments()).toBe(1);
    expect((await invite('a'))?.grantPackageId).toBe(first?.grantPackageId);
    expect((await invite('b'))?.grantPackageId).toBe(first?.grantPackageId);
  });
});
