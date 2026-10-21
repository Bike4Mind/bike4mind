import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import {
  CreditTransaction,
  Session,
  User,
  creditTransactionRepository,
  sessionRepository,
  userRepository,
} from '@bike4mind/database';
import {
  lastSeenAt,
  reserveVoiceHold,
  settleVoiceHold,
  voiceHoldSettleTransactionId,
  type VoiceHold,
} from './settleVoiceHold';
import { MAX_SESSION_SECONDS } from '@bike4mind/server-utils/voice/voiceSessionLimits';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// Voice hold balance moves against a real replica set: each one commits with its hold and ledger
// row, or not at all.

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

// The unique transactionId index is what rejects a second settlement row, and dropDatabase removes it.
beforeEach(async () => {
  await CreditTransaction.createIndexes();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await mongoose.connection.dropDatabase();
});

const HOLD_CREDITS = 600;
const STARTING_BALANCE = 1000;
const STARTED = new Date(Date.now() - 2 * MAX_SESSION_SECONDS * 1000);

async function seedHold(): Promise<VoiceHold> {
  const user = await User.create({
    name: 'Caller',
    username: `caller-${Math.random().toString(36).slice(2, 10)}`,
    password: null,
    hasUsablePassword: false,
    // The bootstrap already took the hold out of the balance.
    currentCredits: STARTING_BALANCE - HOLD_CREDITS,
  });
  const connectedAt = new Date(STARTED.getTime() + 5_000);
  // Last seen a third of the longest call after connecting: a third of the hold is charged.
  const lastActivityAt = new Date(connectedAt.getTime() + (MAX_SESSION_SECONDS / 3) * 1000);
  const session = await Session.create({
    name: 'Voice',
    userId: user.id,
    firstCreated: STARTED,
    lastUpdated: STARTED,
    voiceReservedCredits: HOLD_CREDITS,
    voiceSessionStartedAt: STARTED,
    voiceConnectedAt: connectedAt,
    voiceLastActivityAt: lastActivityAt,
  });
  return {
    id: session.id,
    userId: user.id,
    voiceReservedCredits: HOLD_CREDITS,
    voiceSessionStartedAt: STARTED,
    voiceConnectedAt: connectedAt,
    voiceLastActivityAt: lastActivityAt,
  };
}

const endOf = (hold: VoiceHold) => lastSeenAt(hold);
const balanceOf = async (userId: string) => (await User.findById(userId).lean())?.currentCredits;
const ledgerRows = (hold: VoiceHold) =>
  CreditTransaction.countDocuments({
    transactionId: voiceHoldSettleTransactionId(hold.id, hold.voiceSessionStartedAt),
  });
const openHold = async (hold: VoiceHold) => (await Session.findById(hold.id).lean())?.voiceSessionStartedAt ?? null;

describe('settleVoiceHold on a real replica set', () => {
  it('settling the same hold twice moves the balance once', async () => {
    const hold = await seedHold();

    const first = await settleVoiceHold(hold, endOf(hold), 'end');
    const second = await settleVoiceHold(hold, endOf(hold), 'sweep');

    expect(first).toMatchObject({ settled: true, chargedCredits: 200, refundedCredits: 400 });
    expect(second).toEqual({ settled: false });
    expect(await balanceOf(hold.userId)).toBe(STARTING_BALANCE - 200);
    expect(await ledgerRows(hold)).toBe(1);
    expect(await openHold(hold)).toBeNull();
  });

  it('settling the same hold concurrently moves the balance once', async () => {
    const hold = await seedHold();

    const results = await Promise.all([
      settleVoiceHold(hold, endOf(hold), 'end'),
      settleVoiceHold(hold, endOf(hold), 'sweep'),
      settleVoiceHold(hold, endOf(hold), 'bootstrap'),
    ]);

    expect(results.filter(r => r.settled)).toHaveLength(1);
    expect(await balanceOf(hold.userId)).toBe(STARTING_BALANCE - 200);
    expect(await ledgerRows(hold)).toBe(1);
  });

  it('a retry after a committed settlement does not move the balance again', async () => {
    const hold = await seedHold();
    const realTransaction = mongoose.connection.transaction.bind(mongoose.connection);
    // The commit lands but its acknowledgement never reaches the caller.
    vi.spyOn(mongoose.connection, 'transaction').mockImplementationOnce(async (fn, options) => {
      await realTransaction(fn, options);
      throw new Error('connection reset after commit');
    });

    await expect(settleVoiceHold(hold, endOf(hold), 'end')).rejects.toThrow('connection reset after commit');
    expect(await settleVoiceHold(hold, endOf(hold), 'end')).toEqual({ settled: false });

    expect(await balanceOf(hold.userId)).toBe(STARTING_BALANCE - 200);
    expect(await ledgerRows(hold)).toBe(1);
  });

  it('a failure inside settlement leaves balance, hold and ledger unchanged', async () => {
    const hold = await seedHold();
    // Fails after the claim and the refund have both been written inside the transaction.
    vi.spyOn(creditTransactionRepository, 'createTransaction').mockRejectedValueOnce(new Error('ledger write failed'));

    await expect(settleVoiceHold(hold, endOf(hold), 'end')).rejects.toThrow('ledger write failed');

    expect(await balanceOf(hold.userId)).toBe(STARTING_BALANCE - HOLD_CREDITS);
    expect(await ledgerRows(hold)).toBe(0);
    expect(await openHold(hold)).toEqual(STARTED);

    // The sweep still finds the hold and settles it, exactly once.
    const [stale] = await sessionRepository.findStaleVoiceHolds(new Date(), new Date(), 10);
    expect(stale).toMatchObject({ id: hold.id, voiceReservedCredits: HOLD_CREDITS });
    expect(await settleVoiceHold(stale, lastSeenAt(stale), 'sweep')).toMatchObject({ settled: true });
    expect(await balanceOf(hold.userId)).toBe(STARTING_BALANCE - 200);
    expect(await ledgerRows(hold)).toBe(1);
    expect(await openHold(hold)).toBeNull();
  });
});

describe('reserveVoiceHold on a real replica set', () => {
  const seedSession = async () => {
    const user = await User.create({
      name: 'Caller',
      username: `caller-${Math.random().toString(36).slice(2, 10)}`,
      password: null,
      hasUsablePassword: false,
      currentCredits: STARTING_BALANCE,
    });
    const now = new Date();
    const session = await Session.create({ name: 'Voice', userId: user.id, firstCreated: now, lastUpdated: now });
    return { userId: user.id as string, sessionId: session.id as string };
  };
  const reserve = (ids: { userId: string; sessionId: string }) =>
    reserveVoiceHold({
      ...ids,
      priorStartedAt: null,
      reservedCredits: HOLD_CREDITS,
      startedAt: new Date(),
      realtime: false,
      unaffordable: () => new Error('insufficient credits'),
    });

  it('opens the hold and takes the reserve together', async () => {
    const ids = await seedSession();

    expect(await reserve(ids)).toBe(true);

    expect(await balanceOf(ids.userId)).toBe(STARTING_BALANCE - HOLD_CREDITS);
    expect((await Session.findById(ids.sessionId).lean())?.voiceReservedCredits).toBe(HOLD_CREDITS);
  });

  it('a failed reserve leaves no open hold and no balance change', async () => {
    const ids = await seedSession();
    vi.spyOn(userRepository, 'incrementCredits').mockRejectedValueOnce(new Error('balance write failed'));

    await expect(reserve(ids)).rejects.toThrow('balance write failed');

    expect(await balanceOf(ids.userId)).toBe(STARTING_BALANCE);
    const session = await Session.findById(ids.sessionId).lean();
    expect(session?.voiceSessionStartedAt ?? null).toBeNull();
    expect(session?.voiceReservedCredits ?? null).toBeNull();
  });

  it('of two concurrent bootstraps, only the one that opens the hold takes a reserve', async () => {
    const ids = await seedSession();

    const results = await Promise.all([reserve(ids), reserve(ids)]);

    expect(results.sort()).toEqual([false, true]);
    expect(await balanceOf(ids.userId)).toBe(STARTING_BALANCE - HOLD_CREDITS);
  });

  it('a reserve the balance no longer covers leaves no open hold and no balance change', async () => {
    const ids = await seedSession();
    await User.updateOne({ _id: ids.userId }, { $set: { currentCredits: HOLD_CREDITS - 1 } });

    await expect(reserve(ids)).rejects.toThrow('insufficient credits');

    expect(await balanceOf(ids.userId)).toBe(HOLD_CREDITS - 1);
    const session = await Session.findById(ids.sessionId).lean();
    expect(session?.voiceSessionStartedAt ?? null).toBeNull();
    expect(session?.voiceReservedCredits ?? null).toBeNull();
  });

  it('of two concurrent calls the balance covers once, only one takes a reserve', async () => {
    const first = await seedSession();
    await User.updateOne({ _id: first.userId }, { $set: { currentCredits: HOLD_CREDITS + 1 } });
    const now = new Date();
    const second = await Session.create({ name: 'Voice', userId: first.userId, firstCreated: now, lastUpdated: now });

    const results = await Promise.allSettled([
      reserve(first),
      reserve({ userId: first.userId, sessionId: second.id as string }),
    ]);

    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await balanceOf(first.userId)).toBe(1);
    const open = await Session.countDocuments({ userId: first.userId, voiceSessionStartedAt: { $ne: null } });
    expect(open).toBe(1);
  });
});
