import type { IUserDocument } from '@bike4mind/common';
import {
  CreditTransaction,
  Organization,
  PendingCreditHoldModel,
  User,
  creditTransactionRepository,
  pendingCreditHoldRepository,
  userRepository,
} from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import mongoose, { Types } from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';

const acknowledgement = vi.hoisted(() => ({ loseNextCommit: false }));
vi.mock('@bike4mind/database', async importOriginal => {
  const database = await importOriginal<typeof import('@bike4mind/database')>();
  return {
    ...database,
    withTransaction: async <T>(callback: () => Promise<T>): Promise<T> => {
      const result = await database.withTransaction(callback);
      if (acknowledgement.loseNextCommit) {
        acknowledgement.loseNextCommit = false;
        throw new Error('commit succeeded, acknowledgement lost');
      }
      return result;
    },
  };
});

import { reserveRequestCredits } from './reserveRequestCredits';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: MongoMemoryReplSet;
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger;
const ledger = { type: 'sound_effects_usage', sessionId: 'integration', model: 'test', source: 'api' } as const;

beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await Promise.all([
    User.createCollection(),
    Organization.createCollection(),
    PendingCreditHoldModel.createCollection(),
    CreditTransaction.createCollection(),
  ]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  acknowledgement.loseNextCommit = false;
  await Promise.all([
    User.collection.deleteMany({}),
    Organization.collection.deleteMany({}),
    PendingCreditHoldModel.collection.deleteMany({}),
    CreditTransaction.collection.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

async function caller() {
  const id = new Types.ObjectId();
  await User.collection.insertOne({ _id: id, currentCredits: 100 });
  const user = { id: id.toHexString(), organizationId: null } as IUserDocument;
  return {
    req: { user, logger },
    balance: async () => (await User.collection.findOne({ _id: id }))?.currentCredits,
  };
}

describe('request credit hold transactions against a replica set', () => {
  it('rolls the debit and pending record back when recording fails after its write', async () => {
    const { req, balance } = await caller();
    const record = pendingCreditHoldRepository.record.bind(pendingCreditHoldRepository);
    vi.spyOn(pendingCreditHoldRepository, 'record').mockImplementationOnce(async (...args) => {
      await record(...args);
      throw new Error('record interrupted');
    });

    await expect(
      reserveRequestCredits({ req, requiredCredits: 10, enforceCredits: true, featureLabel: 'test' })
    ).rejects.toThrow('record interrupted');
    expect(await balance()).toBe(100);
    expect(await PendingCreditHoldModel.countDocuments()).toBe(0);
  });

  it('rolls claim and refund back together, allowing a later refund', async () => {
    const { req, balance } = await caller();
    const reservation = await reserveRequestCredits({
      req,
      requiredCredits: 10,
      enforceCredits: true,
      featureLabel: 'test',
    });
    const increment = userRepository.incrementCredits.bind(userRepository);
    vi.spyOn(userRepository, 'incrementCredits').mockImplementationOnce(async (...args) => {
      await increment(...args);
      throw new Error('refund interrupted');
    });

    await reservation.refund();
    expect(await balance()).toBe(90);
    expect(await PendingCreditHoldModel.countDocuments({ settledAt: { $exists: false } })).toBe(1);
    await reservation.refund();
    expect(await balance()).toBe(100);
    expect(await PendingCreditHoldModel.countDocuments()).toBe(0);
  });

  it('keeps an unsettled recoverable hold when every ledger write fails after insertion', async () => {
    const { req, balance } = await caller();
    const reservation = await reserveRequestCredits({
      req,
      requiredCredits: 10,
      enforceCredits: true,
      featureLabel: 'test',
    });
    const create = creditTransactionRepository.createTransaction.bind(creditTransactionRepository);
    vi.spyOn(creditTransactionRepository, 'createTransaction').mockImplementation(async (...args) => {
      await create(...args);
      throw new Error('ledger interrupted');
    });

    expect(await reservation.settle(2, ledger)).toBe(0);
    expect(await balance()).toBe(90);
    expect(await CreditTransaction.countDocuments()).toBe(0);
    expect(await PendingCreditHoldModel.countDocuments({ settledAt: { $exists: false } })).toBe(1);
    await reservation.refund();
    expect(await balance()).toBe(100);
  });

  it('reconciles a lost commit acknowledgement without refunding or writing the ledger twice', async () => {
    const { req, balance } = await caller();
    const reservation = await reserveRequestCredits({
      req,
      requiredCredits: 10,
      enforceCredits: true,
      featureLabel: 'test',
    });
    acknowledgement.loseNextCommit = true;

    expect(await reservation.settle(2, ledger)).toBe(2);
    expect(await balance()).toBe(98);
    expect(await reservation.settle(2, ledger)).toBe(2);
    await reservation.refund();
    expect(await balance()).toBe(98);
    expect(await CreditTransaction.countDocuments()).toBe(1);
    expect(await PendingCreditHoldModel.countDocuments({ settledCredits: 2 })).toBe(1);
  });

  it('rolls organization balance and member usage back with a failed ledger write, then settles once', async () => {
    const { req, balance } = await caller();
    const organizationId = new Types.ObjectId();
    await Organization.collection.insertOne({
      _id: organizationId,
      userId: req.user.id,
      currentCredits: 100,
      userDetails: [{ id: req.user.id, usedCredits: 0 }],
    });
    const reservation = await reserveRequestCredits({
      req: { ...req, user: { ...req.user, organizationId: organizationId.toHexString() } },
      requiredCredits: 10,
      enforceCredits: true,
      featureLabel: 'test',
    });
    const create = creditTransactionRepository.createTransaction.bind(creditTransactionRepository);
    const write = vi.spyOn(creditTransactionRepository, 'createTransaction').mockImplementation(async (...args) => {
      await create(...args);
      throw new Error('ledger interrupted');
    });

    expect(await reservation.settle(2, ledger)).toBe(0);
    const failed = await Organization.collection.findOne({ _id: organizationId });
    expect(failed?.currentCredits).toBe(90);
    expect(failed?.userDetails?.[0]?.usedCredits).toBe(0);
    expect(await CreditTransaction.countDocuments()).toBe(0);
    expect(await PendingCreditHoldModel.countDocuments({ settledAt: { $exists: false } })).toBe(1);

    write.mockRestore();
    expect(await reservation.settle(2, ledger)).toBe(2);
    expect(await reservation.settle(2, ledger)).toBe(2);
    const settled = await Organization.collection.findOne({ _id: organizationId });
    expect(settled?.currentCredits).toBe(98);
    expect(settled?.userDetails?.[0]?.usedCredits).toBe(2);
    expect(await balance()).toBe(100);
    expect(await CreditTransaction.countDocuments()).toBe(1);
  });

  it('reconciles a zero-credit settlement after a lost acknowledgement', async () => {
    const { req, balance } = await caller();
    const reservation = await reserveRequestCredits({
      req,
      requiredCredits: 1,
      enforceCredits: true,
      featureLabel: 'test',
    });
    acknowledgement.loseNextCommit = true;

    expect(await reservation.settle(0, ledger)).toBe(0);
    expect(await balance()).toBe(100);
    expect(await reservation.settle(0, ledger)).toBe(0);
    expect(await balance()).toBe(100);
    expect(await CreditTransaction.countDocuments()).toBe(0);
    expect(await PendingCreditHoldModel.countDocuments({ settledCredits: 0 })).toBe(1);
  });

  it('commits either settlement or refund when they race, without returning credits twice', async () => {
    const { req, balance } = await caller();
    const reservation = await reserveRequestCredits({
      req,
      requiredCredits: 10,
      enforceCredits: true,
      featureLabel: 'test',
    });

    const [charged] = await Promise.all([reservation.settle(2, ledger), reservation.refund()]);

    expect([0, 2]).toContain(charged);
    expect(await balance()).toBe(100 - charged);
    expect(await CreditTransaction.countDocuments()).toBe(charged === 0 ? 0 : 1);
    expect(await PendingCreditHoldModel.countDocuments({ settledAt: { $exists: false } })).toBe(0);
  });
});
