import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { CreditLot, CreditTransaction, User, creditLotRepository, userRepository } from '@bike4mind/database';
import { grantCreditPurchase, type CreditPurchaseGrant } from './grantCreditPurchase';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// The purchase money path against a real replica set: the ledger row is the webhook's "already
// granted" signal, so it must never exist without the balance increment behind it.

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

// The unique stripePaymentIntentId index is part of what stops a double grant, and dropDatabase
// removes it with the data - rebuild it for every test.
beforeEach(async () => {
  await CreditTransaction.createIndexes();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await mongoose.connection.dropDatabase();
});

const seedBuyer = async () =>
  User.create({
    name: 'Buyer',
    username: `buyer-${Math.random().toString(36).slice(2, 10)}`,
    password: null,
    hasUsablePassword: false,
    currentCredits: 100,
  });

const grantFor = (userId: string): CreditPurchaseGrant => ({
  userId,
  paymentIntentId: 'pi_e2e',
  credits: 500,
  amount: 999,
  packageId: 'pkg_1',
  environment: 'test',
  paymentMethod: 'card',
});

const balanceOf = async (userId: string) => (await User.findById(userId).lean())?.currentCredits;
const ledgerRows = () => CreditTransaction.countDocuments({ stripePaymentIntentId: 'pi_e2e' });
const lots = () => CreditLot.countDocuments({ stripeRef: 'pi_e2e' });

describe('grantCreditPurchase on a real replica set', () => {
  it('records one ledger row, one balance increment and one pack lot', async () => {
    const user = await seedBuyer();

    expect(await grantCreditPurchase(grantFor(user.id))).toBe('granted');

    expect(await balanceOf(user.id)).toBe(600);
    expect(await ledgerRows()).toBe(1);
    expect(await lots()).toBe(1);
  });

  it('runs the grant with snapshot reads and majority writes', async () => {
    const user = await seedBuyer();
    const transaction = vi.spyOn(mongoose.connection, 'transaction');

    await grantCreditPurchase(grantFor(user.id));

    expect(transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } })
    );
  });

  it('leaves no ledger row when the balance write fails between the two writes', async () => {
    const user = await seedBuyer();
    vi.spyOn(userRepository, 'incrementCredits').mockRejectedValueOnce(new Error('balance write failed'));

    await expect(grantCreditPurchase(grantFor(user.id))).rejects.toThrow('balance write failed');

    expect(await ledgerRows()).toBe(0);
    expect(await balanceOf(user.id)).toBe(100);
    expect(await lots()).toBe(0);
  });

  it('completes the grant exactly once when Stripe redelivers after a failed attempt', async () => {
    const user = await seedBuyer();
    const increment = vi
      .spyOn(userRepository, 'incrementCredits')
      .mockRejectedValueOnce(new Error('balance write failed'));
    await expect(grantCreditPurchase(grantFor(user.id))).rejects.toThrow('balance write failed');
    increment.mockRestore();

    expect(await grantCreditPurchase(grantFor(user.id))).toBe('granted');
    expect(await grantCreditPurchase(grantFor(user.id))).toBe('already_granted');

    expect(await balanceOf(user.id)).toBe(600);
    expect(await ledgerRows()).toBe(1);
    expect(await lots()).toBe(1);
  });

  it('grants exactly once when a transient error aborts an attempt after both writes', async () => {
    const user = await seedBuyer();
    const realIncrement = userRepository.incrementCredits.bind(userRepository);
    let calls = 0;
    vi.spyOn(userRepository, 'incrementCredits').mockImplementation(async (...args) => {
      const updated = await realIncrement(...args);
      calls += 1;
      if (calls === 1) {
        throw new mongoose.mongo.MongoServerError({
          message: 'write conflict',
          code: 112,
          errorLabels: ['TransientTransactionError'],
        });
      }
      return updated;
    });

    expect(await grantCreditPurchase(grantFor(user.id))).toBe('granted');

    expect(calls).toBe(2);
    expect(await balanceOf(user.id)).toBe(600);
    expect(await ledgerRows()).toBe(1);
    expect(await lots()).toBe(1);
  });

  it('still grants when stamping the pack lot fails after the commit', async () => {
    const user = await seedBuyer();
    vi.spyOn(creditLotRepository, 'create').mockRejectedValueOnce(new Error('lot write failed'));

    expect(await grantCreditPurchase(grantFor(user.id))).toBe('granted');

    expect(await balanceOf(user.id)).toBe(600);
    expect(await ledgerRows()).toBe(1);
    expect(await lots()).toBe(0);
    // The redelivery acknowledges without re-stamping: the missing lot is left to the daily sweep.
    expect(await grantCreditPurchase(grantFor(user.id))).toBe('already_granted');
    expect(await lots()).toBe(0);
  });

  it('grants concurrent deliveries of the same intent exactly once', async () => {
    const user = await seedBuyer();

    const results = await Promise.all([
      grantCreditPurchase(grantFor(user.id)),
      grantCreditPurchase(grantFor(user.id)),
      grantCreditPurchase(grantFor(user.id)),
    ]);

    expect(results.filter(r => r === 'granted')).toHaveLength(1);
    expect(results.filter(r => r === 'already_granted')).toHaveLength(2);
    expect(await balanceOf(user.id)).toBe(600);
    expect(await ledgerRows()).toBe(1);
  });
});
