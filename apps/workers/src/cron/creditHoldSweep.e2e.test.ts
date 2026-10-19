import { CreditHolderType } from '@bike4mind/common';
import {
  PendingCreditHoldModel,
  User,
  pendingCreditHoldRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import mongoose, { Types } from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
// createMongoReplSet is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';

vi.mock('@server/utils/cloudwatch', () => ({ emitMetrics: vi.fn() }));
vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://host/%STAGE%' } }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));

import { runCreditHoldSweep } from './creditHoldSweep';

// The mocked creditHoldSweep.test.ts fakes the transaction. This runs the real one on a replica set, so the
// claim-plus-refund rollback and the single-winner claim are proven against Mongo itself.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: MongoMemoryReplSet;

beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  // Collections cannot be created implicitly inside a transaction on every server version.
  await Promise.all([User.createCollection(), PendingCreditHoldModel.createCollection()]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

afterEach(async () => {
  await Promise.all([User.collection.deleteMany({}), PendingCreditHoldModel.collection.deleteMany({})]);
  vi.restoreAllMocks();
});

const NOW = new Date('2026-10-19T12:00:00Z');
const STARTING_CREDITS = 100;
const HELD = 30;

const balance = async (userId: string) =>
  (await User.collection.findOne({ _id: new Types.ObjectId(userId) }))?.currentCredits;

/** Moves the balance and records the pending row in one transaction, as reserveRequestCredits does. */
async function abandonedHold(expiresAt: Date) {
  const userId = new Types.ObjectId().toHexString();
  await User.collection.insertOne({ _id: new Types.ObjectId(userId), currentCredits: STARTING_CREDITS });
  return withTransaction(async () => {
    await userRepository.incrementCredits(userId, -HELD);
    return pendingCreditHoldRepository.record(
      {
        ownerId: userId,
        ownerType: CreditHolderType.User,
        userId,
        organizationId: null,
        reservedCredits: HELD,
        balanceAfterHold: STARTING_CREDITS - HELD,
      },
      'e2e',
      expiresAt
    );
  });
}

describe('runCreditHoldSweep against a replica set', () => {
  it('refunds an expired hold once and never again', async () => {
    const hold = await abandonedHold(new Date(NOW.getTime() - 60_000));
    expect(await balance(hold.ownerId)).toBe(STARTING_CREDITS - HELD);

    const first = await runCreditHoldSweep({ now: NOW, emitMetrics: false });
    expect(first).toMatchObject({ reclaimed: 1, reclaimedCredits: HELD, failed: 0 });
    expect(await balance(hold.ownerId)).toBe(STARTING_CREDITS);
    expect(await PendingCreditHoldModel.countDocuments()).toBe(0);

    const second = await runCreditHoldSweep({ now: NOW, emitMetrics: false });
    expect(second).toMatchObject({ candidates: 0, reclaimed: 0 });
    expect(await balance(hold.ownerId)).toBe(STARTING_CREDITS);
  });

  it('leaves a hold that has not expired yet', async () => {
    const hold = await abandonedHold(new Date(NOW.getTime() + 60_000));

    expect(await runCreditHoldSweep({ now: NOW, emitMetrics: false })).toMatchObject({ candidates: 0 });
    expect(await balance(hold.ownerId)).toBe(STARTING_CREDITS - HELD);
    expect(await PendingCreditHoldModel.countDocuments()).toBe(1);
  });

  it('rolls the claim back when the refund fails, and the next run refunds it', async () => {
    const hold = await abandonedHold(new Date(NOW.getTime() - 60_000));
    // The refund write lands, then the transaction fails: both it and the claim must roll back.
    const increment = userRepository.incrementCredits.bind(userRepository);
    vi.spyOn(userRepository, 'incrementCredits').mockImplementationOnce(async (...args) => {
      await increment(...args);
      throw new Error('write conflict');
    });

    expect(await runCreditHoldSweep({ now: NOW, emitMetrics: false })).toMatchObject({ reclaimed: 0, failed: 1 });
    expect(await PendingCreditHoldModel.countDocuments()).toBe(1);
    expect(await balance(hold.ownerId)).toBe(STARTING_CREDITS - HELD);

    expect(await runCreditHoldSweep({ now: NOW, emitMetrics: false })).toMatchObject({ reclaimed: 1, failed: 0 });
    expect(await balance(hold.ownerId)).toBe(STARTING_CREDITS);
  });

  it('does not refund a completed settlement receipt after its original expiry', async () => {
    const hold = await abandonedHold(new Date(NOW.getTime() - 60_000));
    expect(await pendingCreditHoldRepository.markSettled(hold.id, HELD)).toBe(true);

    expect(await runCreditHoldSweep({ now: NOW, emitMetrics: false })).toMatchObject({ candidates: 0 });
    expect(await balance(hold.ownerId)).toBe(STARTING_CREDITS - HELD);
    expect(await PendingCreditHoldModel.countDocuments()).toBe(1);
    expect(await pendingCreditHoldRepository.findSettlement(hold.id)).toBe(HELD);
    expect(await pendingCreditHoldRepository.claimExpired(hold.id, NOW)).toBeNull();
  });

  it('refunds once when two sweeps overlap', async () => {
    const hold = await abandonedHold(new Date(NOW.getTime() - 60_000));

    const runs = await Promise.all([
      runCreditHoldSweep({ now: NOW, emitMetrics: false }),
      runCreditHoldSweep({ now: NOW, emitMetrics: false }),
    ]);

    expect(runs.reduce((sum, r) => sum + r.reclaimed, 0)).toBe(1);
    expect(runs.reduce((sum, r) => sum + r.failed, 0)).toBe(0);
    expect(await balance(hold.ownerId)).toBe(STARTING_CREDITS);
  });
});
