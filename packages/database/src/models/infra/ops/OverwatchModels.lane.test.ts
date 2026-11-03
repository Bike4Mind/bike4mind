import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { OVERWATCH_USER_DAY_SYNTHETIC_LANE_INDEX, OverwatchUserDay } from './OverwatchUserDayModel';
import { OverwatchUserFirstSeen } from './OverwatchUserFirstSeenModel';
import { OverwatchRollup } from './OverwatchRollupModel';

/**
 * The lane fields the analytics consumer writes onto the per-user rows and the rollups. Declared, they
 * survive mongoose's default strict mode, so a writer needs no `strict: false`. Undeclared, the same
 * write succeeds and the field is silently dropped - which only a real write can show. None has a
 * default, so a row written or read without one stays "unmarked" rather than gaining a value.
 */
let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await Promise.all([OverwatchUserDay.init(), OverwatchUserFirstSeen.init(), OverwatchRollup.init()]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

afterEach(async () => {
  await Promise.all([
    OverwatchUserDay.collection.deleteMany({}),
    OverwatchUserFirstSeen.collection.deleteMany({}),
    OverwatchRollup.collection.deleteMany({}),
  ]);
});

const KEY = { productId: 'blog', date: '2026-10-01', userId: 'u-1' };

describe('OverwatchUserDay lane', () => {
  it('keeps a synthetic mark set by the consumer upsert under the default strict mode', async () => {
    await OverwatchUserDay.updateOne(KEY, { $set: { ...KEY, lane: 'synthetic' } }, { upsert: true });

    const raw = await OverwatchUserDay.collection.findOne(KEY);
    expect(raw?.lane).toBe('synthetic');
  });

  it('writes no lane for an unmarked upsert, and leaves an existing mark in place', async () => {
    await OverwatchUserDay.updateOne(KEY, { $set: { ...KEY, userType: 'free' } }, { upsert: true });
    expect(await OverwatchUserDay.collection.findOne(KEY)).not.toHaveProperty('lane');

    await OverwatchUserDay.updateOne(KEY, { $set: { ...KEY, lane: 'synthetic' } }, { upsert: true });
    await OverwatchUserDay.updateOne(KEY, { $set: { ...KEY, userType: 'free' } }, { upsert: true });
    expect((await OverwatchUserDay.collection.findOne(KEY))?.lane).toBe('synthetic');
  });

  it('reads and re-saves a row from before the lane without adding one', async () => {
    await OverwatchUserDay.collection.insertOne({ ...KEY, createdAt: new Date() } as never);

    const doc = await OverwatchUserDay.findOne(KEY);
    expect(doc?.lane).toBeUndefined();
    doc!.userType = 'trial';
    await doc!.save();
    const raw = await OverwatchUserDay.collection.findOne(KEY);
    expect(raw?.userType).toBe('trial');
    expect(raw).not.toHaveProperty('lane');
  });

  it('rejects a lane other than synthetic', async () => {
    await expect(OverwatchUserDay.create({ ...KEY, lane: 'real' })).rejects.toThrow(/lane/);
  });

  it('declares the synthetic-lane partial index, so autoIndex builds it where the migration has not run', async () => {
    const idx = (await OverwatchUserDay.collection.indexes()).find(
      i => i.name === OVERWATCH_USER_DAY_SYNTHETIC_LANE_INDEX
    );
    expect(idx).toMatchObject({ key: { productId: 1, date: 1 }, partialFilterExpression: { lane: 'synthetic' } });
  });
});

describe('OverwatchUserFirstSeen lane', () => {
  const FIRST_SEEN = { productId: 'blog', userId: 'u-1' };

  it("keeps the consumer's synthetic mark under the default strict mode, and writes none unmarked", async () => {
    await OverwatchUserFirstSeen.updateOne(
      FIRST_SEEN,
      { $min: { firstSeenDate: '2026-10-01' }, $setOnInsert: FIRST_SEEN, $set: { lane: 'synthetic' } },
      { upsert: true }
    );
    expect((await OverwatchUserFirstSeen.collection.findOne(FIRST_SEEN))?.lane).toBe('synthetic');

    const other = { productId: 'blog', userId: 'u-2' };
    await OverwatchUserFirstSeen.updateOne(
      other,
      { $min: { firstSeenDate: '2026-10-01' }, $setOnInsert: other },
      { upsert: true }
    );
    expect(await OverwatchUserFirstSeen.collection.findOne(other)).not.toHaveProperty('lane');
  });

  it('rejects a lane other than synthetic', async () => {
    await expect(
      OverwatchUserFirstSeen.create({ ...FIRST_SEEN, firstSeenDate: '2026-10-01', lane: 'real' })
    ).rejects.toThrow(/lane/);
  });
});

describe('OverwatchRollup synthetic counts', () => {
  const ROLLUP = { productId: 'blog', date: '2026-10-01' };

  it('keeps the synthetic counts set by the rollup upsert under the default strict mode', async () => {
    const counts = { dau: 10, wau: 40, mau: 90, syntheticDau: 2, syntheticWau: 3, syntheticMau: 4 };
    await OverwatchRollup.updateOne(ROLLUP, { $set: { ...ROLLUP, ...counts } }, { upsert: true });

    const raw = await OverwatchRollup.collection.findOne(ROLLUP);
    expect(raw).toMatchObject({ syntheticDau: 2, syntheticWau: 3, syntheticMau: 4 });
  });

  it('leaves a rollup from before the split without synthetic counts, not with zeros', async () => {
    await OverwatchRollup.collection.insertOne({ ...ROLLUP, dau: 10, wau: 40, mau: 90 } as never);

    const doc = await OverwatchRollup.findOne(ROLLUP);
    expect(doc?.syntheticDau).toBeUndefined();
    expect(doc?.syntheticWau).toBeUndefined();
    expect(doc?.syntheticMau).toBeUndefined();
    doc!.dau = 11;
    await doc!.save();
    const raw = await OverwatchRollup.collection.findOne(ROLLUP);
    expect(raw?.dau).toBe(11);
    expect(raw).not.toHaveProperty('syntheticDau');
    expect(raw).not.toHaveProperty('syntheticWau');
    expect(raw).not.toHaveProperty('syntheticMau');
  });
});
