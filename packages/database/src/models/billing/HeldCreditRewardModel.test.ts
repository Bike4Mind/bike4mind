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
