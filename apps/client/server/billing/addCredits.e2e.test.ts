import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { CreditHolderType, type ICreditHolderMethods } from '@bike4mind/common';
import {
  Agent,
  CreditLot,
  CreditTransaction,
  Organization,
  User,
  agentRepository,
  creditLotRepository,
  creditTransactionRepository,
  organizationRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { creditService } from '@bike4mind/services';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await CreditTransaction.createIndexes();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([
    Agent.deleteMany({}, { hardDelete: true }),
    CreditLot.deleteMany({}),
    CreditTransaction.deleteMany({}),
    Organization.deleteMany({}),
    User.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

const transactionId = 'credit-grant:test';
const startingCredits = 100;
const grantCredits = 50;

const seedUser = () =>
  User.create({
    name: 'Test recipient',
    username: 'test-recipient',
    password: null,
    hasUsablePassword: false,
    currentCredits: startingCredits,
  });

const userBalance = async (id: string) => (await User.findById(id).lean())?.currentCredits;

const holderCases = [
  {
    ownerType: CreditHolderType.User,
    creditHolderMethods: userRepository,
    seed: async () => (await seedUser()).id,
    balanceOf: userBalance,
  },
  {
    ownerType: CreditHolderType.Organization,
    creditHolderMethods: organizationRepository,
    seed: async () =>
      (
        await Organization.create({
          name: 'Test organization',
          userId: (await seedUser()).id,
          currentCredits: startingCredits,
        })
      ).id,
    balanceOf: async (id: string) => (await Organization.findById(id).lean())?.currentCredits,
  },
  {
    ownerType: CreditHolderType.Agent,
    creditHolderMethods: agentRepository,
    seed: async () =>
      (
        await Agent.create({
          name: 'Test agent',
          description: 'Credit grant recipient',
          userId: (await seedUser()).id,
          currentCredits: startingCredits,
        })
      ).id,
    balanceOf: async (id: string) => (await Agent.findById(id).lean())?.currentCredits,
  },
] satisfies Array<{
  ownerType: CreditHolderType;
  creditHolderMethods: ICreditHolderMethods;
  seed(): Promise<string>;
  balanceOf(id: string): Promise<number | undefined>;
}>;

const grantFor = (ownerId: string, ownerType = CreditHolderType.User) =>
  ({
    type: 'generic_add',
    ownerId,
    ownerType,
    credits: grantCredits,
    description: 'Test credit grant',
    transactionId,
  }) as const;

const adaptersFor = (creditHolderMethods: ICreditHolderMethods = userRepository) => ({
  db: { creditTransactions: creditTransactionRepository },
  creditHolderMethods,
});

const ledgerRows = () => CreditTransaction.countDocuments({ transactionId });

describe('addCredits on a real replica set', () => {
  it.each(holderCases)(
    'rolls back a failed $ownerType balance write and applies the retry only once',
    async ({ ownerType, creditHolderMethods, seed, balanceOf }) => {
      const ownerId = await seed();
      const grant = grantFor(ownerId, ownerType);
      const adapters = adaptersFor(creditHolderMethods);
      vi.spyOn(adapters.creditHolderMethods, 'incrementCredits').mockRejectedValueOnce(
        new Error('balance write failed')
      );

      await expect(creditService.addCredits(grant, adapters)).rejects.toThrow('balance write failed');
      expect(await ledgerRows()).toBe(0);
      expect(await balanceOf(ownerId)).toBe(startingCredits);

      await expect(creditService.addCredits(grant, adapters)).resolves.toMatchObject({
        currentCredits: startingCredits + grantCredits,
      });
      await expect(creditService.addCreditsWithLedgerRow(grant, adapters)).resolves.toMatchObject({
        creditHolder: { currentCredits: startingCredits + grantCredits },
        creditTransactionId: undefined,
      });
      expect(await ledgerRows()).toBe(1);
      expect(await balanceOf(ownerId)).toBe(startingCredits + grantCredits);
    }
  );

  it('uses the caller transaction to credit a newly created holder and handle a replay', async () => {
    const transaction = vi.spyOn(mongoose.connection, 'transaction');
    const ownerId = await withTransaction(async () => {
      const user = await seedUser();
      const grant = grantFor(user.id);

      await creditService.addCredits(grant, adaptersFor());
      await expect(creditService.addCreditsWithLedgerRow(grant, adaptersFor())).resolves.toMatchObject({
        creditHolder: { currentCredits: startingCredits + grantCredits },
        creditTransactionId: undefined,
      });

      return user.id;
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(await ledgerRows()).toBe(1);
    expect(await userBalance(ownerId)).toBe(startingCredits + grantCredits);
  });

  it('rolls back both grant writes when the caller transaction fails later', async () => {
    const user = await seedUser();

    await expect(
      withTransaction(async () => {
        await creditService.addCredits(grantFor(user.id), adaptersFor());
        expect(await ledgerRows()).toBe(1);
        expect(await userBalance(user.id)).toBe(startingCredits + grantCredits);
        throw new Error('caller failed');
      })
    ).rejects.toThrow('caller failed');

    expect(await ledgerRows()).toBe(0);
    expect(await userBalance(user.id)).toBe(startingCredits);
  });

  it('rolls back when the caller catches the balance write failure inside its transaction', async () => {
    const user = await seedUser();
    const failure = new Error('balance write failed');
    vi.spyOn(userRepository, 'incrementCredits').mockRejectedValueOnce(failure);

    await expect(
      withTransaction(async () => {
        await expect(creditService.addCredits(grantFor(user.id), adaptersFor())).rejects.toBe(failure);
      })
    ).rejects.toBe(failure);

    expect(await ledgerRows()).toBe(0);
    expect(await userBalance(user.id)).toBe(startingCredits);
  });

  it('gives concurrent copies of the same grant one ledger row and one balance increment', async () => {
    const user = await seedUser();
    const grant = grantFor(user.id);
    const adapters = adaptersFor();

    const results = await Promise.all([
      creditService.addCreditsWithLedgerRow(grant, adapters),
      creditService.addCreditsWithLedgerRow(grant, adapters),
    ]);

    expect(results.filter(result => result.creditTransactionId)).toHaveLength(1);
    expect(await ledgerRows()).toBe(1);
    expect(await userBalance(user.id)).toBe(startingCredits + grantCredits);
  });

  it('keeps the committed ledger and balance when the optional lot write fails', async () => {
    const user = await seedUser();
    let stateAtLotWrite: { rows: number; balance: number | undefined } | undefined;
    const lotWrite = vi.spyOn(creditLotRepository, 'create').mockImplementationOnce(async () => {
      stateAtLotWrite = { rows: await ledgerRows(), balance: await userBalance(user.id) };
      throw new Error('lot write failed');
    });

    await withTransaction(() =>
      creditService.addCredits(grantFor(user.id), {
        ...adaptersFor(),
        db: { creditTransactions: creditTransactionRepository, creditLots: creditLotRepository },
      })
    );

    expect(lotWrite).toHaveBeenCalledTimes(1);
    expect(stateAtLotWrite).toEqual({ rows: 1, balance: startingCredits + grantCredits });
    expect(await CreditLot.countDocuments({ ownerId: user.id })).toBe(0);
    expect(await ledgerRows()).toBe(1);
    expect(await userBalance(user.id)).toBe(startingCredits + grantCredits);
  });
});
