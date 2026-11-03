import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { ApiKeyScope, ApiKeyStatus } from '@bike4mind/common';
import {
  AdminAuditLogModel,
  CreditTransaction,
  StripeDisputeModel,
  User,
  UserApiKey,
  stripeDisputeRepository,
} from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { usersBulkUndoDeps } from '@server/admin/usersBulk/adapters';
import {
  DISPUTE_SYSTEM_ACTOR_ID,
  DisputeContainUndoRefused,
  disputeFacts,
  resolveLostUserDispute,
  resolveWonDispute,
  undoDisputeContain,
  type StripeDisputeEvent,
} from './stripeDisputes';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// Real transactions need a replica set: the Contain and the dispute resolution commit together here.
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

beforeEach(async () => {
  await StripeDisputeModel.createIndexes();
});

// The audit log refuses deletes through its model, so drop the database instead.
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

// Stripe fixture: the fields of a closed dispute the webhook reads.
const stripeDispute = (overrides: Partial<StripeDisputeEvent> = {}): StripeDisputeEvent => ({
  id: 'dp_test_lost',
  amount: 2000,
  currency: 'usd',
  reason: 'fraudulent',
  status: 'lost',
  created: 1_790_000_000,
  charge: 'ch_test_1',
  payment_intent: 'pi_test_1',
  ...overrides,
});

const seedUser = async (overrides: Record<string, unknown> = {}) => {
  const tag = Math.random().toString(36).slice(2, 10);
  const doc = await User.create({
    name: `User ${tag}`,
    username: `user-${tag}`,
    email: `user-${tag}@example.com`,
    password: null,
    hasUsablePassword: false,
    currentCredits: 500,
    disputePending: true,
    ...overrides,
  });
  return doc.id as string;
};

const seedKey = async (userId: string) => {
  const key = await UserApiKey.create({
    userId,
    name: 'key',
    keyHash: '$2b$12$abcdefghijklmnopqrstuv',
    keyPrefix: `b4m_live_disp${Math.random().toString(36).slice(2, 6)}`,
    scopes: [ApiKeyScope.AI_GENERATE],
    metadata: { createdFrom: 'dashboard' as const },
    status: ApiKeyStatus.ACTIVE,
  });
  return key.id as string;
};

const closeFor = async (userId: string, dispute = stripeDispute()) =>
  stripeDisputeRepository.recordClosed(disputeFacts(dispute, 'user', userId), new Date());

const adminReq = (adminId: string) =>
  ({
    user: { id: adminId, username: 'admin', name: 'Admin', email: 'admin@example.com', isAdmin: true },
    headers: {},
    url: '/api/admin/stripe-disputes/undo-contain',
    requestId: 'req-1',
    logger,
  }) as unknown as Parameters<typeof usersBulkUndoDeps>[0];

describe('resolveLostUserDispute', () => {
  it('resolves the dispute, contains the account and keeps the dispute flag, attributed to the system', async () => {
    const userId = await seedUser();
    const keyId = await seedKey(userId);
    const record = await closeFor(userId);

    const outcome = await resolveLostUserDispute(record, { id: userId }, logger);

    expect(outcome.status).toBe('contained');
    const user = await User.findById(userId).lean();
    expect(user?.isBanned).toBe(true);
    expect(user?.disputePending).toBe(true);
    expect(user?.currentCredits).toBe(0);
    const key = await UserApiKey.findById(keyId).lean();
    expect(key?.status).not.toBe(ApiKeyStatus.ACTIVE);

    const stored = await stripeDisputeRepository.findById(record.id);
    expect(stored?.state).toBe('resolved');
    expect(stored?.resolution).toMatchObject({ outcome: 'lost', resolvedBy: null });
    expect(stored?.contain).toMatchObject({
      batchId: 'stripe-dispute:dp_test_lost',
      suspended: true,
      creditDelta: -500,
      apiKeysRevoked: 1,
      undoneAt: null,
    });

    const entries = await AdminAuditLogModel.find({}).lean();
    const actions = entries.map(entry => entry.action).sort();
    expect(actions).toEqual(['billing.dispute.resolved', 'user.bulk.contained']);
    for (const entry of entries) expect(entry.actor).toMatchObject({ kind: 'system', name: 'Stripe dispute' });

    const ledger = await CreditTransaction.findOne({ ownerId: userId }).lean();
    expect(ledger?.metadata).toMatchObject({ actorId: DISPUTE_SYSTEM_ACTOR_ID });
  });

  it('acts once when the close is delivered again', async () => {
    const userId = await seedUser();
    const first = await closeFor(userId);
    await resolveLostUserDispute(first, { id: userId }, logger);
    // An admin lifted the suspension in between: a redelivery must not suspend again.
    await User.updateOne({ _id: userId }, { $set: { isBanned: false, currentCredits: 40 } });

    const again = await closeFor(userId);
    const outcome = await resolveLostUserDispute(again, { id: userId }, logger);

    expect(outcome.status).toBe('already_resolved');
    const user = await User.findById(userId).lean();
    expect(user).toMatchObject({ isBanned: false, currentCredits: 40 });
    expect(await AdminAuditLogModel.countDocuments({ action: 'user.bulk.contained' })).toBe(1);
  });

  it('rolls the Contain back when a concurrent close resolved the dispute first', async () => {
    const userId = await seedUser();
    const record = await closeFor(userId);
    // Another delivery won the race after this one read the record as open.
    await stripeDisputeRepository.resolveBySystem(record.stripeDisputeId, 'lost');

    const outcome = await resolveLostUserDispute(record, { id: userId }, logger);

    expect(outcome.status).toBe('already_resolved');
    const user = await User.findById(userId).lean();
    expect(user).toMatchObject({ isBanned: false, currentCredits: 500 });
    expect(await AdminAuditLogModel.countDocuments({ action: 'user.bulk.contained' })).toBe(0);
  });

  it('resolves without a Contain when the account is already contained', async () => {
    const userId = await seedUser({ isBanned: true, currentCredits: 0 });
    const record = await closeFor(userId);

    const outcome = await resolveLostUserDispute(record, { id: userId }, logger);

    expect(outcome.status).toBe('resolved_without_contain');
    if (outcome.status === 'resolved_without_contain') expect(outcome.item.contain).toBeNull();
    expect(await AdminAuditLogModel.countDocuments({ action: 'billing.dispute.resolved' })).toBe(1);
  });

  it('sets the dispute flag when the close arrives without its open event', async () => {
    const userId = await seedUser({ disputePending: false });
    const keyId = await seedKey(userId);
    const adminId = await seedUser({ isAdmin: true, disputePending: false });
    const record = await closeFor(userId);

    await resolveLostUserDispute(record, { id: userId }, logger);
    expect((await User.findById(userId).lean())?.disputePending).toBe(true);

    // So the undo still leaves the account blocked.
    const dispute = await stripeDisputeRepository.findById(record.id);
    await undoDisputeContain(dispute!, adminId, usersBulkUndoDeps(adminReq(adminId), logger));
    expect((await User.findById(userId).lean())?.disputePending).toBe(true);
    expect((await UserApiKey.findById(keyId).lean())?.status).not.toBe(ApiKeyStatus.ACTIVE);
  });

  it('never contains an admin account automatically', async () => {
    const userId = await seedUser({ isAdmin: true });
    const record = await closeFor(userId);

    const outcome = await resolveLostUserDispute(record, { id: userId, isAdmin: true }, logger);

    expect(outcome.status).toBe('resolved_without_contain');
    const user = await User.findById(userId).lean();
    expect(user).toMatchObject({ isBanned: false, currentCredits: 500, disputePending: true });
  });
});

describe('resolveWonDispute', () => {
  it('resolves the record as won without touching the account', async () => {
    const userId = await seedUser();
    await closeFor(userId, stripeDispute({ id: 'dp_test_won', status: 'won' }));

    await resolveWonDispute('dp_test_won', logger);

    const stored = await StripeDisputeModel.findOne({ stripeDisputeId: 'dp_test_won' }).lean();
    expect(stored).toMatchObject({ state: 'resolved', resolution: { outcome: 'won' } });
    // Clearing the flag is the webhook's job, on a won dispute only.
    expect((await User.findById(userId).lean())?.disputePending).toBe(true);
  });
});

describe('undoDisputeContain', () => {
  it('unsuspends and restores the credits but keeps the keys off while the dispute flag is set', async () => {
    const userId = await seedUser();
    const keyId = await seedKey(userId);
    const adminId = await seedUser({ isAdmin: true, disputePending: false });
    const record = await closeFor(userId);
    await resolveLostUserDispute(record, { id: userId }, logger);
    const dispute = await stripeDisputeRepository.findById(record.id);

    const undone = await undoDisputeContain(dispute!, adminId, usersBulkUndoDeps(adminReq(adminId), logger));

    expect(undone.contain).toMatchObject({ undoneBy: adminId });
    expect(undone.contain?.undoneAt).toBeInstanceOf(Date);
    const user = await User.findById(userId).lean();
    expect(user).toMatchObject({ isBanned: false, currentCredits: 500, disputePending: true });
    expect((await UserApiKey.findById(keyId).lean())?.status).not.toBe(ApiKeyStatus.ACTIVE);
    const undoEntry = await AdminAuditLogModel.findOne({ action: 'user.bulk.undone' }).lean();
    expect(undoEntry?.actor).toMatchObject({ kind: 'user' });
  });

  it('refuses a second undo without changing the account again', async () => {
    const userId = await seedUser();
    const adminId = await seedUser({ isAdmin: true, disputePending: false });
    const record = await closeFor(userId);
    await resolveLostUserDispute(record, { id: userId }, logger);
    const dispute = await stripeDisputeRepository.findById(record.id);
    const deps = usersBulkUndoDeps(adminReq(adminId), logger);
    await undoDisputeContain(dispute!, adminId, deps);

    // A stale read that still shows the Contain as live: the conditional write refuses and rolls back.
    await expect(undoDisputeContain(dispute!, adminId, deps)).rejects.toBeInstanceOf(DisputeContainUndoRefused);
    expect((await User.findById(userId).lean())?.currentCredits).toBe(500);
    expect(await AdminAuditLogModel.countDocuments({ action: 'user.bulk.undone' })).toBe(1);
  });
});
