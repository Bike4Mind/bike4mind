import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { CreditHolderType } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import {
  CreditLot,
  CreditTransaction,
  Organization,
  User,
  creditLotRepository,
  userRepository,
} from '@bike4mind/database';
import {
  createMongoReplSet,
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { processHolder } from './creditLotSweep';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let mongo: Awaited<ReturnType<typeof createMongoReplSet>>;
const now = new Date('2026-10-09T04:00:00Z');
const logger = new Logger();

async function seedHolder(balance = 100, amount = 100, expiresAt = now) {
  const user = await User.create({
    username: `expiry-${new mongoose.Types.ObjectId()}`,
    name: 'Expiry fixture',
    currentCredits: balance,
  });
  const ownerId = String(user._id);
  const lot = await CreditLot.create({
    ownerId,
    ownerType: CreditHolderType.User,
    source: 'promo',
    amount,
    consumedAssigned: 0,
    expiresAt,
  });
  return { ownerId, ownerType: CreditHolderType.User, lotId: String(lot._id) };
}

async function persisted({ ownerId, lotId }: Awaited<ReturnType<typeof seedHolder>>) {
  const [user, lot, transactions] = await Promise.all([
    User.findById(ownerId).lean(),
    CreditLot.findById(lotId).lean(),
    CreditTransaction.find({ ownerId, reason: 'credit_expiry' }).lean(),
  ]);
  return { balance: user?.currentCredits, assigned: lot?.consumedAssigned, transactions };
}

beforeAll(async () => {
  mongo = await createMongoReplSet();
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop({ doCleanup: false });
});

describe('credit expiry atomic persisted effects', () => {
  it.each(['before balance', 'before lot stamp', 'missing lot stamp'] as const)(
    'rolls back every write after failure %s',
    async failureAt => {
      const holder = await seedHolder();
      if (failureAt === 'before balance') {
        vi.spyOn(userRepository, 'incrementCredits').mockRejectedValueOnce(new Error('fixture balance failure'));
      } else if (failureAt === 'missing lot stamp') {
        vi.spyOn(creditLotRepository, 'update').mockResolvedValueOnce(null);
      } else {
        vi.spyOn(creditLotRepository, 'update').mockRejectedValueOnce(new Error('fixture stamp failure'));
      }

      await expect(processHolder(holder, now, logger)).rejects.toThrow(
        failureAt === 'missing lot stamp' ? 'Failed to update credit lot' : 'fixture'
      );
      expect(await persisted(holder)).toEqual({ balance: 100, assigned: 0, transactions: [] });

      vi.restoreAllMocks();
      expect(await processHolder(holder, now, logger)).toEqual({ expiredLots: 1, expiredCredits: 100 });
      const after = await persisted(holder);
      expect(after).toMatchObject({ balance: 0, assigned: 100 });
      expect(after.transactions).toHaveLength(1);
      expect(after.transactions[0]).toMatchObject({ type: 'generic_deduct', reason: 'credit_expiry', credits: -100 });
    }
  );

  it('reloads the balance on conflict and expires once across concurrent and repeated runs', async () => {
    const holder = await seedHolder(100, 100);
    const find = userRepository.findById.bind(userRepository);
    let initialReads = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => {
      release = resolve;
    });
    vi.spyOn(userRepository, 'findById').mockImplementation(async id => {
      const snapshot = await find(id);
      if (id === holder.ownerId && initialReads < 2) {
        initialReads++;
        if (initialReads === 2) release();
        await barrier;
      }
      return snapshot;
    });

    const outcomes = await Promise.all([processHolder(holder, now, logger), processHolder(holder, now, logger)]);
    expect(outcomes.map(result => result.expiredCredits).sort()).toEqual([0, 100]);
    expect(await processHolder(holder, now, logger)).toEqual({ expiredLots: 0, expiredCredits: 0 });
    const after = await persisted(holder);
    expect(after).toMatchObject({ balance: 0, assigned: 100 });
    expect(after.transactions).toHaveLength(1);
    expect(after.transactions[0].credits).toBe(-100);
  });

  it('preserves FIFO consumption, expiry boundary and a future bonus lot', async () => {
    const holder = await seedHolder(150, 100, new Date(now.getTime() - 1));
    const boundary = await CreditLot.create({
      ownerId: holder.ownerId,
      ownerType: holder.ownerType,
      source: 'pack',
      amount: 100,
      consumedAssigned: 0,
      expiresAt: now,
    });
    const future = await CreditLot.create({
      ownerId: holder.ownerId,
      ownerType: holder.ownerType,
      source: 'promo',
      amount: 100,
      consumedAssigned: 0,
      expiresAt: new Date(now.getTime() + 1),
    });
    expect(await processHolder(holder, now, logger)).toEqual({ expiredLots: 1, expiredCredits: 50 });
    expect(await persisted(holder)).toMatchObject({ balance: 100, assigned: 100 });
    expect((await CreditLot.findById(boundary._id).lean())?.consumedAssigned).toBe(100);
    expect((await CreditLot.findById(future._id).lean())?.consumedAssigned).toBe(0);
    const ledger = await CreditTransaction.find({ ownerId: holder.ownerId }).lean();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].credits).toBe(-50);
    const ledgerId = String(ledger[0]._id);
    await processHolder(holder, now, logger);
    expect((await CreditTransaction.find({ ownerId: holder.ownerId }).lean()).map(row => String(row._id))).toEqual([
      ledgerId,
    ]);
  });

  it('expires organization credits once and retains its ledger on serial replay', async () => {
    const owner = await User.create({
      username: `org-expiry-${new mongoose.Types.ObjectId()}`,
      name: 'Org owner fixture',
    });
    const organization = await Organization.create({
      name: 'Expiry organization fixture',
      userId: String(owner._id),
      currentCredits: 75,
    });
    const holder = { ownerId: String(organization._id), ownerType: CreditHolderType.Organization };
    const lot = await CreditLot.create({
      ...holder,
      source: 'subscription',
      amount: 100,
      consumedAssigned: 0,
      expiresAt: now,
    });
    expect(await processHolder(holder, now, logger)).toEqual({ expiredLots: 1, expiredCredits: 75 });
    expect((await Organization.findById(holder.ownerId).lean())?.currentCredits).toBe(0);
    expect((await CreditLot.findById(lot._id).lean())?.consumedAssigned).toBe(100);
    const first = await CreditTransaction.find({ ...holder, reason: 'credit_expiry' }).lean();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ ...holder, type: 'generic_deduct', reason: 'credit_expiry', credits: -75 });
    expect(await processHolder(holder, now, logger)).toEqual({ expiredLots: 0, expiredCredits: 0 });
    expect(
      (await CreditTransaction.find({ ...holder, reason: 'credit_expiry' }).lean()).map(row => String(row._id))
    ).toEqual(first.map(row => String(row._id)));
    expect((await Organization.findById(holder.ownerId).lean())?.currentCredits).toBe(0);
  });

  it('leaves a zero-balance holder and zero-amount promo lot intact', async () => {
    const holder = await seedHolder(0, 0);
    expect(await processHolder(holder, now, logger)).toEqual({ expiredLots: 0, expiredCredits: 0 });
    expect(await persisted(holder)).toEqual({ balance: 0, assigned: 0, transactions: [] });
  });

  it('does not expire the same lot again when the balance exceeds recorded grants', async () => {
    const holder = await seedHolder(300, 100);
    const future = await CreditLot.create({
      ownerId: holder.ownerId,
      ownerType: holder.ownerType,
      source: 'promo',
      amount: 100,
      consumedAssigned: 40,
      expiresAt: new Date(now.getTime() + 86_400_000),
    });
    expect(await processHolder(holder, now, logger)).toEqual({ expiredLots: 1, expiredCredits: 100 });
    const first = await persisted(holder);
    expect(first).toMatchObject({ balance: 200, assigned: 100 });
    expect(first.transactions).toHaveLength(1);
    expect(await processHolder(holder, now, logger)).toEqual({ expiredLots: 0, expiredCredits: 0 });
    const repeated = await persisted(holder);
    expect(repeated).toMatchObject({ balance: 200, assigned: 100 });
    expect(repeated.transactions.map(row => String(row._id))).toEqual(first.transactions.map(row => String(row._id)));
    expect((await CreditLot.findById(future._id).lean())?.consumedAssigned).toBe(0);
  });

  it('fails closed on a standalone database without changing balances, lots or ledger', async () => {
    const standalone = await createMongoServer();
    try {
      await mongoose.disconnect();
      await mongoose.connect(standalone.getUri(), { autoIndex: false });
      await settleAutoIndexBuilds(mongoose);
      const holder = await seedHolder();
      await expect(processHolder(holder, now, logger)).rejects.toMatchObject({ code: 20 });
      expect(await persisted(holder)).toEqual({ balance: 100, assigned: 0, transactions: [] });
    } finally {
      await mongoose.disconnect();
      await standalone.stop({ doCleanup: false });
      await mongoose.connect(mongo.getUri(), { autoIndex: false });
    }
  });
});
