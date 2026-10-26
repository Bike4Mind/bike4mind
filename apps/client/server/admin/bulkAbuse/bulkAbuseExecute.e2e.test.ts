import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { CreditHolderType, type BulkAbuseActions, type IUser } from '@bike4mind/common';
import { AdminAuditLogModel, CreditTransaction, User, userRepository } from '@bike4mind/database';
import { abuseService } from '@bike4mind/services';
import { bulkAbuseCohortAdapters, bulkAbuseExecuteAdapters } from './adapters';

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

const fakeReq = {
  user: { id: ACTOR_ID, username: 'admin', name: 'Admin', email: 'admin@example.com', isAdmin: true },
  headers: {},
  url: '/api/admin/abuse/bulk-execute',
  requestId: 'req-1',
} as unknown as Parameters<typeof bulkAbuseExecuteAdapters>[0];

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

  it('writes a per-user audit entry with the admin reason, and rolls it back with the user step', async () => {
    const user = await seedGrantedUser();
    const banOnly: BulkAbuseActions = {
      ban: true,
      revokeApiKeys: false,
      revokeSessions: false,
      clawbackFreeCredits: false,
    };

    const [banned] = await abuseService.executeBulkAbuse(
      [user],
      banOnly,
      ACTOR_ID,
      bulkAbuseExecuteAdapters(fakeReq, 'bot farm')
    );

    expect(banned.steps.ban).toBe('applied');
    const rows = await AdminAuditLogModel.find({ action: 'abuse.bulk.ban' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].target.id).toBe(user.id);
    expect(rows[0].reason).toBe('bot farm');

    // A later step throwing after the ban's entry was written takes that entry back with the ban.
    const other = await seedGrantedUser();
    const real = bulkAbuseExecuteAdapters(fakeReq, 'bot farm');
    const failingKeys = {
      ...real,
      db: {
        ...real.db,
        userApiKeys: { ...real.db.userApiKeys, count: () => Promise.reject(new Error('keys unavailable')) },
      },
    };
    const [failed] = await abuseService.executeBulkAbuse(
      [other],
      { ...banOnly, revokeApiKeys: true },
      ACTOR_ID,
      failingKeys
    );

    expect(failed.status).toBe('failed');
    expect((await User.findById(other.id).lean())?.isBanned).toBeFalsy();
    expect(await AdminAuditLogModel.countDocuments({ 'target.id': other.id })).toBe(0);
  });
});

describe('resolveBulkAbuseCohort on a real replica set', () => {
  const seed = (email: string) =>
    User.create({
      name: 'Bot',
      username: `bot-${Math.random().toString(36).slice(2, 10)}`,
      email,
      password: null,
      hasUsablePassword: false,
    });

  it('matches the domain and its subdomains case-insensitively and nothing else', async () => {
    const apex = await seed('a@BURNER-EXAMPLE.com');
    const sub = await seed('b@np.burner-example.com');
    await seed('c@notburner-example.com');

    const cohort = await abuseService.resolveBulkAbuseCohort(
      { kind: 'domain', domain: 'burner-example.com' },
      ACTOR_ID,
      bulkAbuseCohortAdapters
    );

    expect(cohort.included.map(user => user.id).sort()).toEqual([apex.id, sub.id].sort());
  });
});
