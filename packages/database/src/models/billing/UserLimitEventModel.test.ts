import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { UserLimitEventModel, userLimitEventRepository } from './UserLimitEventModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await UserLimitEventModel.createCollection();
  await UserLimitEventModel.createIndexes();
});

beforeEach(async () => {
  await UserLimitEventModel.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

describe('userLimitEventRepository.record', () => {
  it('counts hits in one hour into one row, keeping the first and last time and the latest details', async () => {
    await userLimitEventRepository.record({
      userId: 'u1',
      kind: 'free_tier_daily_cap',
      details: { capCredits: 100 },
      at: new Date('2026-11-01T10:20:00Z'),
    });
    await userLimitEventRepository.record({
      userId: 'u1',
      kind: 'free_tier_daily_cap',
      details: { capCredits: 200 },
      at: new Date('2026-11-01T10:50:00Z'),
    });
    await userLimitEventRepository.record({
      userId: 'u1',
      kind: 'free_tier_daily_cap',
      details: { capCredits: 300 },
      at: new Date('2026-11-01T10:05:00Z'),
    });

    const rows = await UserLimitEventModel.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      count: 3,
      modelId: '',
      hour: new Date('2026-11-01T10:00:00Z'),
      firstAt: new Date('2026-11-01T10:05:00Z'),
      lastAt: new Date('2026-11-01T10:50:00Z'),
      details: { capCredits: 300 },
    });
  });

  it('keeps separate rows per hour, kind and model', async () => {
    const at = new Date('2026-11-01T10:00:00Z');
    await userLimitEventRepository.record({ userId: 'u1', kind: 'model_requires_paid_plan', model: 'a', at });
    await userLimitEventRepository.record({ userId: 'u1', kind: 'model_requires_paid_plan', model: 'b', at });
    await userLimitEventRepository.record({ userId: 'u1', kind: 'insufficient_credits', at });
    await userLimitEventRepository.record({
      userId: 'u1',
      kind: 'insufficient_credits',
      at: new Date('2026-11-01T11:00:00Z'),
    });
    expect(await UserLimitEventModel.countDocuments()).toBe(4);
  });

  it('loses no hits when the first hits of an hour race', async () => {
    const at = new Date('2026-11-01T10:00:00Z');
    await Promise.all(
      Array.from({ length: 10 }, () => userLimitEventRepository.record({ userId: 'u1', kind: 'balance_debt', at }))
    );
    const rows = await UserLimitEventModel.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(10);
  });

  it('deletes only the given user rows', async () => {
    await userLimitEventRepository.record({ userId: 'u1', kind: 'balance_debt' });
    await userLimitEventRepository.record({ userId: 'u2', kind: 'balance_debt' });
    expect(await userLimitEventRepository.deleteAllForUser('u1')).toBe(1);
    expect(await UserLimitEventModel.distinct('userId')).toEqual(['u2']);
  });
});
