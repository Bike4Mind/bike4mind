import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';
import { User, Project, CreditTransaction, userRepository } from '@bike4mind/database';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// The claim's money path against a real replica set: the ledger row and the balance are
// written in one transaction, so a failed balance write cannot leave the reward recorded as
// paid, and concurrent claims pay once. Only baseApi is mocked, to reach the handler.

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const mockRefs = vi.hoisted(() => ({ postHandler: null as null | Handler }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    post: (fn: Handler) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

let replSet: MongoMemoryReplSet;
let post: Handler;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri());
  await import('../claim');
  post = mockRefs.postHandler!;
});

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

// The ledger's unique transactionId index is what stops a second payout, and
// dropDatabase removes it with the data - rebuild it for every test.
beforeEach(async () => {
  await CreditTransaction.createIndexes();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await mongoose.connection.dropDatabase();
});

/** A user who owns a project, which unlocks the Projects gear (1000 credits). */
const seedUnlockedUser = async () => {
  const user = await User.create({
    name: 'Claimer',
    username: `claimer-${Math.random().toString(36).slice(2, 10)}`,
    password: null,
    hasUsablePassword: false,
    currentCredits: 0,
  });
  await Project.create({ name: 'First project', description: 'd', userId: user.id, users: [], fileIds: [] });
  return user;
};

const claim = async (userId: string) => {
  const { req, res } = createMocks({ method: 'POST', body: { key: 'projects' } });
  (req as unknown as { user: { id: string } }).user = { id: userId };
  await post(req, res);
  return { status: res._getStatusCode(), body: res._getJSONData() };
};

const balanceOf = async (userId: string) => (await User.findById(userId).lean())?.currentCredits;
const ledgerRows = (userId: string) =>
  CreditTransaction.countDocuments({ transactionId: `gear-unlock:${userId}:projects` });

describe('POST /api/gears/claim on a real replica set', () => {
  it('pays once and records one ledger row', async () => {
    const user = await seedUnlockedUser();

    expect(await claim(user.id)).toEqual({ status: 200, body: { key: 'projects', creditsAwarded: 1000 } });
    expect(await balanceOf(user.id)).toBe(1000);
    expect(await ledgerRows(user.id)).toBe(1);

    // A second claim is a no-op on both the ledger and the balance.
    expect(await claim(user.id)).toEqual({ status: 200, body: { key: 'projects', alreadyClaimed: true } });
    expect(await balanceOf(user.id)).toBe(1000);
  });

  it('pays concurrent claims exactly once, and only one of them announces it', async () => {
    const user = await seedUnlockedUser();

    const results = await Promise.all([claim(user.id), claim(user.id), claim(user.id)]);

    expect(results.filter(r => r.body.creditsAwarded === 1000)).toHaveLength(1);
    expect(results.filter(r => r.body.alreadyClaimed === true)).toHaveLength(2);
    expect(await balanceOf(user.id)).toBe(1000);
    expect(await ledgerRows(user.id)).toBe(1);
  });

  it('rolls the ledger row back when the balance write fails, so a retry still pays', async () => {
    const user = await seedUnlockedUser();
    const increment = vi
      .spyOn(userRepository, 'incrementCredits')
      .mockRejectedValueOnce(new Error('balance write failed'));

    await expect(claim(user.id)).rejects.toThrow('balance write failed');
    expect(await ledgerRows(user.id)).toBe(0);
    expect(await balanceOf(user.id)).toBe(0);

    increment.mockRestore();
    expect(await claim(user.id)).toEqual({ status: 200, body: { key: 'projects', creditsAwarded: 1000 } });
    expect(await balanceOf(user.id)).toBe(1000);
    expect(await ledgerRows(user.id)).toBe(1);
  });
});
