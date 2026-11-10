import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { HeldCreditRewardModel, heldCreditRewardRepository } from './HeldCreditRewardModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { autoIndex: false });
});

beforeEach(async () => {
  await HeldCreditRewardModel.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

const reward = (userId: string, transactionId: string, credits: number) => ({
  transactionId,
  userId,
  credits,
  source: 'gear' as const,
  reason: 'test',
  description: 'test reward',
});

describe('heldCreditRewardRepository.totalsForUser', () => {
  it('counts and sums one user queued and paused rewards, leaving paid and void rows and other users out', async () => {
    await heldCreditRewardRepository.hold(reward('u1', 'tx-1', 10));
    await heldCreditRewardRepository.hold(reward('u1', 'tx-2', 15));
    await heldCreditRewardRepository.hold(reward('u1', 'tx-3', 20));
    await heldCreditRewardRepository.hold(reward('u1', 'tx-4', 30));
    await heldCreditRewardRepository.hold(reward('u2', 'tx-5', 99));
    await heldCreditRewardRepository.settle('tx-3', 'paid');
    await heldCreditRewardRepository.settle('tx-4', 'void');
    await heldCreditRewardRepository.pauseOne('tx-2');

    expect(await heldCreditRewardRepository.totalsForUser('u1')).toEqual({
      held: { count: 1, credits: 10 },
      paused: { count: 1, credits: 15 },
    });
  });

  it('answers zeros for a user with nothing queued', async () => {
    expect(await heldCreditRewardRepository.totalsForUser('nobody')).toEqual({
      held: { count: 0, credits: 0 },
      paused: { count: 0, credits: 0 },
    });
  });
});

describe('heldCreditRewardRepository.totalsForUsers', () => {
  it('returns each user queued and paused totals in one call, zeros for users with no rows', async () => {
    await heldCreditRewardRepository.hold(reward('u1', 'tx-1', 10));
    await heldCreditRewardRepository.hold(reward('u1', 'tx-2', 15));
    await heldCreditRewardRepository.hold(reward('u2', 'tx-3', 20));
    await heldCreditRewardRepository.hold(reward('u2', 'tx-4', 30));
    await heldCreditRewardRepository.hold(reward('u3', 'tx-5', 99));
    await heldCreditRewardRepository.pauseOne('tx-2');
    await heldCreditRewardRepository.settle('tx-4', 'paid');

    const totals = await heldCreditRewardRepository.totalsForUsers(['u1', 'u2', 'none']);
    expect([...totals.keys()]).toEqual(['u1', 'u2', 'none']);
    expect(totals.get('u1')).toEqual({ held: { count: 1, credits: 10 }, paused: { count: 1, credits: 15 } });
    expect(totals.get('u2')).toEqual({ held: { count: 1, credits: 20 }, paused: { count: 0, credits: 0 } });
    expect(totals.get('none')).toEqual({ held: { count: 0, credits: 0 }, paused: { count: 0, credits: 0 } });
    for (const id of ['u1', 'u2']) expect(totals.get(id)).toEqual(await heldCreditRewardRepository.totalsForUser(id));
  });

  it('returns an empty map without querying for an empty id list', async () => {
    const spy = vi.spyOn(HeldCreditRewardModel, 'aggregate');
    expect((await heldCreditRewardRepository.totalsForUsers([])).size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('heldCreditRewardRepository.reduceHeld', () => {
  const row = (transactionId: string) => HeldCreditRewardModel.findOne({ transactionId }).lean();

  it('lowers a held or paused reward only while it still holds the expected amount', async () => {
    await heldCreditRewardRepository.hold(reward('u1', 'tx-1', 100));
    await heldCreditRewardRepository.hold(reward('u1', 'tx-2', 100));
    await heldCreditRewardRepository.pauseOne('tx-2');

    expect(await heldCreditRewardRepository.reduceHeld('tx-1', 100, 40)).toBe(1);
    expect(await heldCreditRewardRepository.reduceHeld('tx-1', 100, 10)).toBe(0);
    expect(await heldCreditRewardRepository.reduceHeld('tx-2', 100, 60)).toBe(1);

    expect(await row('tx-1')).toMatchObject({ credits: 40, status: 'held' });
    expect(await row('tx-2')).toMatchObject({ credits: 60, status: 'paused' });
  });

  it('voids the reward when nothing is left, and never touches a paid one', async () => {
    await heldCreditRewardRepository.hold(reward('u1', 'tx-1', 100));
    await heldCreditRewardRepository.hold(reward('u1', 'tx-2', 100));
    await heldCreditRewardRepository.settle('tx-2', 'paid');

    expect(await heldCreditRewardRepository.reduceHeld('tx-1', 100, 0)).toBe(1);
    expect(await heldCreditRewardRepository.reduceHeld('tx-2', 100, 0)).toBe(0);

    expect(await row('tx-1')).toMatchObject({ status: 'void' });
    expect(await row('tx-2')).toMatchObject({ status: 'paid', credits: 100 });
  });
});

describe('heldCreditRewardRepository.settle', () => {
  it('settles with an expected amount only while the row still holds it', async () => {
    await heldCreditRewardRepository.hold(reward('u1', 'tx-1', 100));
    await heldCreditRewardRepository.reduceHeld('tx-1', 100, 40);

    expect(await heldCreditRewardRepository.settle('tx-1', 'paid', { credits: 100 })).toBe(0);
    expect(await heldCreditRewardRepository.settle('tx-1', 'paid', { credits: 40 })).toBe(1);
    expect(await HeldCreditRewardModel.findOne({ transactionId: 'tx-1' }).lean()).toMatchObject({ status: 'paid' });
  });
});
