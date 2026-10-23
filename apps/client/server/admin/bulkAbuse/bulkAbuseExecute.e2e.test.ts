import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { CreditHolderType, type BulkAbuseActions, type IUser } from '@bike4mind/common';
import { CreditTransaction, User, userRepository } from '@bike4mind/database';
import { abuseService } from '@bike4mind/services';
import { bulkAbuseExecuteAdapters } from './adapters';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// The one-clawback-per-user guard has no unique key: it rests on two runs both writing the user
// document, so the second transaction write-conflicts, retries and sees the first's ledger row.
// Only a replica set runs real transactions, so only here can that guard actually be exercised.

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

afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

const GRANT = 50;
const ACTOR_ID = 'a'.repeat(24);
const CLAWBACK_ONLY: BulkAbuseActions = {
  ban: false,
  revokeApiKeys: false,
  revokeSessions: false,
  clawbackFreeCredits: true,
};

const seedGrantedUser = async (): Promise<IUser> => {
  const doc = await User.create({
    name: 'Bot',
    username: `bot-${Math.random().toString(36).slice(2, 10)}`,
    email: `bot-${Math.random().toString(36).slice(2, 10)}@np.kashre.com`,
    password: null,
    hasUsablePassword: false,
    currentCredits: 80,
  });
  await CreditTransaction.create({
    type: 'generic_add',
    ownerId: doc.id,
    ownerType: CreditHolderType.User,
    credits: GRANT,
    reason: 'admin_adjustment',
    description: 'signup grant',
    transactionId: `verify-grant:${doc.id}`,
  });
  const user = await userRepository.findById(doc.id);
  if (!user) throw new Error('seeded user not found');
  return user;
};

const adapters = (audit: () => Promise<unknown> = async () => null) => ({
  ...bulkAbuseExecuteAdapters({} as Parameters<typeof bulkAbuseExecuteAdapters>[0], 'test reason'),
  audit,
});

const clawbackRows = (userId: string) =>
  CreditTransaction.countDocuments({
    ownerId: userId,
    type: 'generic_deduct',
    reason: abuseService.ABUSE_CLAWBACK_REASON,
  });
const balance = async (userId: string) => (await User.findById(userId).lean())?.currentCredits;

describe('executeBulkAbuse on a real replica set', () => {
  it('claws back once when two runs on the same user race', async () => {
    const user = await seedGrantedUser();

    const [first, second] = await Promise.all([
      abuseService.executeBulkAbuse([user], CLAWBACK_ONLY, ACTOR_ID, adapters()),
      abuseService.executeBulkAbuse([user], CLAWBACK_ONLY, ACTOR_ID, adapters()),
    ]);

    expect(await clawbackRows(user.id)).toBe(1);
    expect(await balance(user.id)).toBe(80 - GRANT);
    const outcomes = [first[0].steps.clawbackFreeCredits, second[0].steps.clawbackFreeCredits].sort();
    expect(outcomes).toEqual(['applied', 'skipped']);
  });

  it('rolls back every step for a user whose audit write fails', async () => {
    const user = await seedGrantedUser();
    const actions: BulkAbuseActions = {
      ban: true,
      revokeApiKeys: false,
      revokeSessions: false,
      clawbackFreeCredits: true,
    };
    let calls = 0;
    // Fail on the second audit entry, after the ban and the clawback ledger row were written.
    const audit = async () => {
      calls += 1;
      if (calls === 2) throw new Error('audit store unavailable');
      return null;
    };

    const [result] = await abuseService.executeBulkAbuse([user], actions, ACTOR_ID, adapters(audit));

    expect(result.status).toBe('failed');
    expect((await User.findById(user.id).lean())?.isBanned).toBeFalsy();
    expect(await clawbackRows(user.id)).toBe(0);
    expect(await balance(user.id)).toBe(80);
  });
});
