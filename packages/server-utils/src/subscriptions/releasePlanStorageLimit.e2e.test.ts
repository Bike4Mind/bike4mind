import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mongoose, User, userRepository } from '@bike4mind/database';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { SubscriptionOwnerType } from '../lib/subscriptions/types';
import { Subscription, subscriptionRepository } from '../models/Subscription';
import { releasePlanStorageLimit } from './releasePlanStorageLimit';

vi.mock('../utils/cloudwatch', () => ({ emitMetric: vi.fn(async () => undefined) }));
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoReplSet>>;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await User.createCollection();
  await Subscription.createCollection();
  await Subscription.ensureIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  vi.clearAllMocks();
  await Promise.all([User.deleteMany({}), Subscription.deleteMany({})]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function seedUser() {
  const user = await User.create({
    username: 'storage-race-' + new mongoose.Types.ObjectId(),
    name: 'Storage race fixture',
    storageLimit: 5000,
    storageLimitOverride: null,
    planStorageLimit: 5000,
  });
  return String(user._id);
}

async function createGrant(userId: string, allowance: number) {
  await Subscription.create({
    ownerType: SubscriptionOwnerType.User,
    ownerId: userId,
    subscriptionId: 'sub_new',
    priceId: 'price_storage',
    status: 'active',
    source: 'stripe',
    canceledAt: null,
    periodStartsAt: new Date('2026-11-01T00:00:00Z'),
    periodEndsAt: new Date('2026-12-01T00:00:00Z'),
    quantity: 1,
  });
  expect(await userRepository.setPlanStorageLimit(userId, allowance)).toBe(true);
}

async function quota(userId: string) {
  const user = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(userId) });
  return {
    storageLimit: user?.storageLimit,
    storageLimitOverride: user?.storageLimitOverride,
    planStorageLimit: user?.planStorageLimit,
    version: user?.__v,
  };
}

describe('releasePlanStorageLimit against concurrent real grants', () => {
  it.each([5000, 9000])(
    'retains a concurrent %i MB grant after an initially empty live-subscription read',
    async allowance => {
      // Freeze Date only: real driver timers still run, while equal grants cannot use a
      // timestamp difference as their transaction fence. Seed and both writes share one instant.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date());
      const userId = await seedUser();
      const read = subscriptionRepository.hasOtherGrantingUserSubscription.bind(subscriptionRepository);
      const observed = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      let paused = false;
      const reads = vi
        .spyOn(subscriptionRepository, 'hasOtherGrantingUserSubscription')
        .mockImplementation(async (...args) => {
          const result = await read(...args);
          if (!paused && !result) {
            paused = true;
            observed.resolve();
            await resume.promise;
          }
          return result;
        });
      const releasing = releasePlanStorageLimit(userId, 'sub_old', logger);
      try {
        await Promise.race([
          observed.promise,
          releasing.then(() => {
            throw new Error('Release finished before the real query barrier');
          }),
        ]);
        await createGrant(userId, allowance);
        resume.resolve();
        await releasing;
        expect(await quota(userId)).toMatchObject({
          storageLimit: allowance,
          storageLimitOverride: null,
          planStorageLimit: allowance,
        });
        expect(reads.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(logger.error).not.toHaveBeenCalled();
      } finally {
        resume.resolve();
        await releasing;
      }
    }
  );

  it('allows a grant that starts while release holds the user write to win after commit', async () => {
    const userId = await seedUser();
    const cleared = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<void>();
    const grantStarted = Promise.withResolvers<void>();
    const clear = userRepository.clearPlanStorageLimit.bind(userRepository);
    const set = userRepository.setPlanStorageLimit.bind(userRepository);
    vi.spyOn(userRepository, 'clearPlanStorageLimit').mockImplementation(async id => {
      const result = await clear(id);
      cleared.resolve();
      await commit.promise;
      return result;
    });
    vi.spyOn(userRepository, 'setPlanStorageLimit').mockImplementation(async (...args) => {
      grantStarted.resolve();
      return set(...args);
    });
    const releasing = releasePlanStorageLimit(userId, 'sub_old', logger);
    let granting: Promise<void> | undefined;
    try {
      await Promise.race([
        cleared.promise,
        releasing.then(() => {
          throw new Error('Release finished before its write barrier');
        }),
      ]);
      granting = createGrant(userId, 9000);
      await Promise.race([
        grantStarted.promise,
        granting.then(() => {
          throw new Error('Grant finished before its write barrier');
        }),
      ]);
      commit.resolve();
      await Promise.all([releasing, granting]);
      expect(await quota(userId)).toMatchObject({ storageLimit: 9000, planStorageLimit: 9000 });
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      commit.resolve();
      await Promise.all([releasing, granting]);
    }
  });

  it('rolls back the actual quota clear if its transaction fails after the write', async () => {
    const userId = await seedUser();
    const before = await quota(userId);
    const clear = userRepository.clearPlanStorageLimit.bind(userRepository);
    const failure = new Error('Injected failure after the actual clear');
    vi.spyOn(userRepository, 'clearPlanStorageLimit').mockImplementation(async id => {
      await clear(id);
      throw failure;
    });

    await expect(releasePlanStorageLimit(userId, 'sub_old', logger)).resolves.toBeUndefined();
    expect(await quota(userId)).toEqual(before);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(expect.any(String), { error: failure });
  });
});
