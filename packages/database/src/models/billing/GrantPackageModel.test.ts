import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { withTransaction } from '@bike4mind/db-core';
import { createMongoReplSet, MONGO_TEST_TIMEOUT_MS, settleAutoIndexBuilds } from '../../__test__/createMongoServer';
import { User } from '../auth/UserModel';
import {
  GrantPackage,
  GrantPackageDayCount,
  GrantPackageRedemption,
  grantPackageRepository,
} from './GrantPackageModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoReplSet>>;
const models = [GrantPackage, GrantPackageRedemption, GrantPackageDayCount, User];

beforeAll(async () => {
  server = await createMongoReplSet();
  mongoose.set('transactionAsyncLocalStorage', true);
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  for (const m of models) await m.createCollection();
  await GrantPackageRedemption.createIndexes();
  await GrantPackageDayCount.createIndexes();
});

beforeEach(async () => {
  for (const m of models) await m.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

const createPackage = async (
  overrides: Partial<{ totalCap: number | null; dailyCap: number | null; active: boolean }>
) =>
  String(
    (
      await GrantPackage.create({
        name: 'Synthetic package',
        credits: 100,
        totalCap: null,
        dailyCap: null,
        createdBy: 'synthetic-admin',
        ...overrides,
      })
    )._id
  );

const reload = async (id: string) => (await GrantPackage.findById(id).lean())!;

describe('GrantPackageRepository.reserveRedemption', () => {
  it('admits exactly one of five concurrent redemptions against a total cap of 1', async () => {
    const id = await createPackage({ totalCap: 1 });
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(n => grantPackageRepository.reserveRedemption(id, `user-${n}`))
    );
    expect(results.filter(r => r.outcome === 'reserved')).toHaveLength(1);
    expect(results.filter(r => r.outcome === 'refused' && r.reason === 'total_cap')).toHaveLength(4);
    const pkg = await reload(id);
    expect(pkg.redeemedTotal).toBe(1);
    expect(pkg.capHits).toBe(4);
    expect(pkg.lastCapHitAt).toBeInstanceOf(Date);
  });

  it('admits exactly one of five concurrent redemptions against a daily cap of 1 and keeps the total in step', async () => {
    const id = await createPackage({ dailyCap: 1 });
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(n => grantPackageRepository.reserveRedemption(id, `user-${n}`))
    );
    expect(results.filter(r => r.outcome === 'reserved')).toHaveLength(1);
    expect(results.filter(r => r.outcome === 'refused' && r.reason === 'daily_cap')).toHaveLength(4);
    expect((await reload(id)).redeemedTotal).toBe(1);
  });

  it('resets the daily cap on the next UTC day', async () => {
    const id = await createPackage({ dailyCap: 1 });
    const day1 = new Date('2026-01-01T23:00:00Z');
    expect((await grantPackageRepository.reserveRedemption(id, 'a', day1)).outcome).toBe('reserved');
    expect(await grantPackageRepository.reserveRedemption(id, 'b', day1)).toEqual({
      outcome: 'refused',
      reason: 'daily_cap',
    });
    expect((await grantPackageRepository.reserveRedemption(id, 'b', new Date('2026-01-02T01:00:00Z'))).outcome).toBe(
      'reserved'
    );
  });

  it('treats both caps null as unlimited', async () => {
    const id = await createPackage({});
    for (const n of [1, 2, 3]) {
      expect((await grantPackageRepository.reserveRedemption(id, `user-${n}`)).outcome).toBe('reserved');
    }
    expect((await reload(id)).redeemedTotal).toBe(3);
  });

  it('refuses an inactive or unknown package', async () => {
    const id = await createPackage({ active: false });
    expect(await grantPackageRepository.reserveRedemption(id, 'a')).toEqual({ outcome: 'refused', reason: 'inactive' });
    expect(await grantPackageRepository.reserveRedemption('not-an-id', 'a')).toEqual({
      outcome: 'refused',
      reason: 'inactive',
    });
  });

  it('returns already for a repeat redemption by the same account without counting it twice', async () => {
    const id = await createPackage({ totalCap: 1 });
    expect((await grantPackageRepository.reserveRedemption(id, 'a')).outcome).toBe('reserved');
    const again = await grantPackageRepository.reserveRedemption(id, 'a');
    expect(again.outcome).toBe('already');
    if (again.outcome !== 'refused') await again.release();
    expect((await reload(id)).redeemedTotal).toBe(1);
    expect(await GrantPackageRedemption.countDocuments({ packageId: id })).toBe(1);
  });

  it('release frees the total and daily slot exactly once', async () => {
    const id = await createPackage({ totalCap: 1, dailyCap: 1 });
    const first = await grantPackageRepository.reserveRedemption(id, 'a');
    if (first.outcome === 'refused') throw new Error('expected a reservation');
    await first.release();
    await first.release();
    expect((await reload(id)).redeemedTotal).toBe(0);
    expect((await GrantPackageDayCount.findOne({ packageId: id }).lean())?.count).toBe(0);
    expect((await grantPackageRepository.reserveRedemption(id, 'b')).outcome).toBe('reserved');
  });

  it('rolls back a redemption with its transaction but keeps the cap-hit record of a refusal', async () => {
    const id = await createPackage({ totalCap: 1 });
    await expect(
      withTransaction(async () => {
        await grantPackageRepository.reserveRedemption(id, 'a');
        throw new Error('signup failed later');
      })
    ).rejects.toThrow('signup failed later');
    expect((await reload(id)).redeemedTotal).toBe(0);
    expect(await GrantPackageRedemption.countDocuments()).toBe(0);

    await grantPackageRepository.reserveRedemption(id, 'b');
    await expect(
      withTransaction(async () => {
        const refused = await grantPackageRepository.reserveRedemption(id, 'c');
        throw new Error(refused.outcome);
      })
    ).rejects.toThrow('refused');
    const pkg = await reload(id);
    expect(pkg.redeemedTotal).toBe(1);
    expect(pkg.capHits).toBe(1);
  });
});

describe('GrantPackageRepository.isInboxClaimed', () => {
  it('reports whether any account holds the canonical inbox claim', async () => {
    await User.collection.insertOne({ username: 'claimed', freeCreditClaimEmail: 'someone@gmail.com' });
    expect(await grantPackageRepository.isInboxClaimed('someone@gmail.com')).toBe(true);
    expect(await grantPackageRepository.isInboxClaimed('other@gmail.com')).toBe(false);
  });
});

describe('GrantPackageRepository admin reads and writes', () => {
  it("lists packages with today's daily-cap count and leaves other days out", async () => {
    const now = new Date('2026-03-01T12:00:00Z');
    const capped = await createPackage({ dailyCap: 5 });
    const open = await createPackage({});
    await grantPackageRepository.reserveRedemption(capped, 'user-1', now);
    await grantPackageRepository.reserveRedemption(capped, 'user-2', new Date('2026-02-28T12:00:00Z'));

    const page = await grantPackageRepository.listPackages({ page: 1, limit: 25, now });
    const byId = new Map(page.data.map(pkg => [pkg.id, pkg]));
    expect(page.meta.total).toBe(2);
    expect(byId.get(capped)).toMatchObject({ redeemedToday: 1, redeemedTotal: 2 });
    expect(byId.get(open)).toMatchObject({ redeemedToday: 0 });
  });

  it('creates and patches a package, and returns null for an unknown id', async () => {
    const created = await grantPackageRepository.create({
      name: 'Launch',
      credits: 100,
      totalCap: 1,
      dailyCap: null,
      createdBy: 'synthetic-admin',
    });
    const updated = await grantPackageRepository.update(created.id, { totalCap: null, reason: 'Internal testing' });
    expect(updated).toMatchObject({ totalCap: null, reason: 'Internal testing', redeemedTotal: 0, active: true });
    expect(await grantPackageRepository.update(new mongoose.Types.ObjectId().toString(), { active: false })).toBeNull();
  });
});
