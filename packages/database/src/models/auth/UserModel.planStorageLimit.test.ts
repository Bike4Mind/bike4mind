import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { User, userRepository } from './UserModel';

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
  await User.deleteMany({});
});

/** `storageLimitOverride: undefined` seeds a row without the field (pre-backfill, or an OAuth signup). */
const seed = async (fields: { storageLimit?: number; storageLimitOverride?: number | null }) => {
  const user = await User.create({ username: `u-${new mongoose.Types.ObjectId()}`, name: 'Plan limit fixture' });
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, ''> = { planStorageLimit: '' };
  for (const key of ['storageLimit', 'storageLimitOverride'] as const) {
    if (fields[key] === undefined) $unset[key] = '';
    else $set[key] = fields[key];
  }
  await User.collection.updateOne({ _id: user._id }, { $set, $unset });
  return String(user._id);
};
const limitsOf = async (id: string) => {
  const row = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
  return {
    storageLimit: row?.storageLimit,
    storageLimitOverride: row?.storageLimitOverride,
    planStorageLimit: row?.planStorageLimit,
  };
};

describe('UserRepository.setPlanStorageLimit', () => {
  it('applies the plan limit when no override is set', async () => {
    const id = await seed({ storageLimit: 1000, storageLimitOverride: null });
    expect(await userRepository.setPlanStorageLimit(id, 5000)).toBe(true);
    expect(await limitsOf(id)).toEqual({ storageLimit: 5000, storageLimitOverride: null, planStorageLimit: 5000 });
  });

  it('records the plan limit but keeps a manual override enforced', async () => {
    const id = await seed({ storageLimit: 20_000, storageLimitOverride: 20_000 });
    expect(await userRepository.setPlanStorageLimit(id, 5000)).toBe(true);
    expect(await limitsOf(id)).toEqual({ storageLimit: 20_000, storageLimitOverride: 20_000, planStorageLimit: 5000 });
  });

  it('keeps a zero override enforced', async () => {
    const id = await seed({ storageLimit: 0, storageLimitOverride: 0 });
    expect(await userRepository.setPlanStorageLimit(id, 5000)).toBe(true);
    expect(await limitsOf(id)).toEqual({ storageLimit: 0, storageLimitOverride: 0, planStorageLimit: 5000 });
  });

  it('keeps a legacy custom limit as the override on a row without the field', async () => {
    const id = await seed({ storageLimit: 2500 });
    expect(await userRepository.setPlanStorageLimit(id, 5000)).toBe(true);
    expect(await limitsOf(id)).toEqual({ storageLimit: 2500, storageLimitOverride: 2500, planStorageLimit: 5000 });
  });

  it('applies the plan limit to a default-limit row without the field (OAuth signup)', async () => {
    const id = await seed({ storageLimit: 1000 });
    expect(await userRepository.setPlanStorageLimit(id, 5000)).toBe(true);
    expect(await limitsOf(id)).toEqual({ storageLimit: 5000, storageLimitOverride: null, planStorageLimit: 5000 });
  });

  it('applies the plan limit to a row with neither limit field', async () => {
    const id = await seed({});
    expect(await userRepository.setPlanStorageLimit(id, 5000)).toBe(true);
    expect(await limitsOf(id)).toEqual({ storageLimit: 5000, storageLimitOverride: null, planStorageLimit: 5000 });
  });

  it('returns false for an unknown or malformed id', async () => {
    expect(await userRepository.setPlanStorageLimit(String(new mongoose.Types.ObjectId()), 5000)).toBe(false);
    expect(await userRepository.setPlanStorageLimit('not-an-id', 5000)).toBe(false);
  });
});
