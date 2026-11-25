import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { DEFAULT_STORAGE_LIMIT_MB } from '@bike4mind/common';
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
afterEach(() => vi.restoreAllMocks());

/** `storageLimitOverride: undefined` seeds a row without the field (pre-backfill, or an OAuth signup). */
const seed = async (fields: {
  storageLimit?: number | null;
  storageLimitOverride?: number | null;
  planStorageLimit?: number | null;
}) => {
  const user = await User.create({ username: `u-${new mongoose.Types.ObjectId()}`, name: 'Plan limit fixture' });
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, ''> = {};
  for (const key of ['storageLimit', 'storageLimitOverride', 'planStorageLimit'] as const) {
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

describe('UserRepository.clearPlanStorageLimit', () => {
  it('falls back to the default limit when no override is set', async () => {
    const id = await seed({ storageLimit: 5000, storageLimitOverride: null, planStorageLimit: 5000 });
    expect(await userRepository.clearPlanStorageLimit(id)).toBe(true);
    expect(await limitsOf(id)).toEqual({
      storageLimit: DEFAULT_STORAGE_LIMIT_MB,
      storageLimitOverride: null,
      planStorageLimit: null,
    });
  });

  it('keeps a manual override enforced', async () => {
    const id = await seed({ storageLimit: 20_000, storageLimitOverride: 20_000, planStorageLimit: 5000 });
    expect(await userRepository.clearPlanStorageLimit(id)).toBe(true);
    expect(await limitsOf(id)).toEqual({ storageLimit: 20_000, storageLimitOverride: 20_000, planStorageLimit: null });
  });

  it('keeps a zero override enforced', async () => {
    const id = await seed({ storageLimit: 0, storageLimitOverride: 0, planStorageLimit: 5000 });
    expect(await userRepository.clearPlanStorageLimit(id)).toBe(true);
    expect(await limitsOf(id)).toEqual({ storageLimit: 0, storageLimitOverride: 0, planStorageLimit: null });
  });

  it('keeps a legacy custom limit as the override on a row without the field', async () => {
    const id = await seed({ storageLimit: 2500 });
    expect(await userRepository.clearPlanStorageLimit(id)).toBe(true);
    expect(await limitsOf(id)).toEqual({ storageLimit: 2500, storageLimitOverride: 2500, planStorageLimit: null });
  });

  it('leaves the stored usage untouched, so a user over the new limit keeps every file', async () => {
    const id = await seed({ storageLimit: 5000, storageLimitOverride: null, planStorageLimit: 5000 });
    await User.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { currentStorageSize: 4e9 } });
    expect(await userRepository.clearPlanStorageLimit(id)).toBe(true);
    expect(await userRepository.findCurrentStorageSize(id)).toBe(4e9);
  });

  it('is idempotent across a redelivery', async () => {
    const id = await seed({ storageLimit: 5000, storageLimitOverride: null, planStorageLimit: 5000 });
    await userRepository.clearPlanStorageLimit(id);
    const once = await limitsOf(id);
    expect(await userRepository.clearPlanStorageLimit(id)).toBe(true);
    expect(await limitsOf(id)).toEqual(once);
  });

  it('returns false for an unknown or malformed id', async () => {
    expect(await userRepository.clearPlanStorageLimit(String(new mongoose.Types.ObjectId()))).toBe(false);
    expect(await userRepository.clearPlanStorageLimit('not-an-id')).toBe(false);
  });
});

describe('portable plan storage writes', () => {
  it.each(['grant', 'release'] as const)('uses ordinary update operators for a %s', async operation => {
    const id = await seed({ storageLimit: 5000, storageLimitOverride: null, planStorageLimit: 5000 });
    const update = User.collection.updateOne.bind(User.collection);
    vi.spyOn(User.collection, 'updateOne').mockImplementation((filter, changes, options) => {
      if (Array.isArray(changes)) throw new Error('The supported backend rejects update pipelines');
      return update(filter, changes, options);
    });

    const changed =
      operation === 'grant'
        ? await userRepository.setPlanStorageLimit(id, 9000)
        : await userRepository.clearPlanStorageLimit(id);

    expect(changed).toBe(true);
    expect(await limitsOf(id)).toEqual({
      storageLimit: operation === 'grant' ? 9000 : DEFAULT_STORAGE_LIMIT_MB,
      storageLimitOverride: null,
      planStorageLimit: operation === 'grant' ? 9000 : null,
    });
  });

  it.each(['grant', 'release'] as const)('preserves a mixed legacy custom limit during a %s', async operation => {
    const id = await seed({ storageLimit: 2500, planStorageLimit: 5000 });
    if (operation === 'grant') await userRepository.setPlanStorageLimit(id, 9000);
    else await userRepository.clearPlanStorageLimit(id);
    expect(await limitsOf(id)).toEqual({
      storageLimit: 2500,
      storageLimitOverride: 2500,
      planStorageLimit: operation === 'grant' ? 9000 : null,
    });
  });

  it('does not turn an explicit null override into a legacy custom override', async () => {
    const id = await seed({ storageLimit: 2500, storageLimitOverride: null });
    await userRepository.setPlanStorageLimit(id, 0);
    expect(await limitsOf(id)).toEqual({ storageLimit: 0, storageLimitOverride: null, planStorageLimit: 0 });
  });
});

describe('conditional storage allowance writes', () => {
  it.each(['grant', 'release'] as const)('advances the version even for an identical %s', async operation => {
    const id = await seed({ storageLimit: 5000, storageLimitOverride: null, planStorageLimit: 5000 });
    const version = async () => (await User.collection.findOne({ _id: new mongoose.Types.ObjectId(id) }))?.__v;
    const initial = await version();
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (operation === 'grant') await userRepository.setPlanStorageLimit(id, 5000);
      else await userRepository.clearPlanStorageLimit(id);
      expect(await version()).toBe(initial + attempt);
    }
  });

  it.each([
    ['grant', 0],
    ['grant', 2500],
    ['grant', null],
    ['release', 0],
    ['release', 2500],
    ['release', null],
  ] as const)('preserves a concurrent manual override %s / %s', async (operation, override) => {
    const id = await seed({
      storageLimit: 5000,
      storageLimitOverride: override === null ? 2500 : null,
      planStorageLimit: 5000,
    });
    const update = User.collection.updateOne.bind(User.collection);
    let changed = false;
    const writes = vi.spyOn(User.collection, 'updateOne').mockImplementation(async (filter, changes, options) => {
      if (!changed) {
        changed = true;
        // A real admin write need not change __v. The exact quota predicates must detect it.
        await update(
          { _id: new mongoose.Types.ObjectId(id) },
          {
            $set: { storageLimitOverride: override, storageLimit: override ?? 5000 },
          }
        );
      }
      return update(filter, changes, options);
    });
    const plan = operation === 'grant' ? 9000 : null;
    if (operation === 'grant') expect(await userRepository.setPlanStorageLimit(id, 9000)).toBe(true);
    else expect(await userRepository.clearPlanStorageLimit(id)).toBe(true);
    expect(writes).toHaveBeenCalledTimes(2);
    expect(await limitsOf(id)).toEqual({
      storageLimitOverride: override,
      planStorageLimit: plan,
      storageLimit: override ?? plan ?? DEFAULT_STORAGE_LIMIT_MB,
    });
  });

  it('initializes a missing legacy version with an ordinary increment', async () => {
    const id = await seed({ storageLimit: 1000 });
    await User.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $unset: { __v: '' } });
    await userRepository.setPlanStorageLimit(id, 5000);
    expect((await User.collection.findOne({ _id: new mongoose.Types.ObjectId(id) }))?.__v).toBe(1);
  });

  it('does not silently repair a corrupt null version', async () => {
    const id = await seed({ storageLimit: 1000 });
    await User.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { __v: null } });
    await expect(userRepository.setPlanStorageLimit(id, 5000)).rejects.toThrow();
    expect(await limitsOf(id)).toEqual({
      storageLimit: 1000,
      storageLimitOverride: undefined,
      planStorageLimit: undefined,
    });
  });
});
