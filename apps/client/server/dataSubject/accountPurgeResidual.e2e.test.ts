import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ADMIN_ERASURE_COMPLETED_ACTION } from '@bike4mind/common';
import { AdminAuditLogModel, ErasureRecordModel, Session, mongoose } from '@bike4mind/database';
import { inboxRepository } from '@bike4mind/database/social';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
// Registered outside the `@bike4mind/database` barrel, so they register only when imported.
import '@bike4mind/server-utils/models/Subscription';
import '@server/models/UserSubscription';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';

// Only what leaves the database is stubbed; every purge step that writes Mongo runs for real.
vi.mock('@bike4mind/server-utils/users/purgeAccountFiles', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/users/purgeAccountFiles')>()),
  purgeAccountFiles: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/users/accountDeletionEmail', () => ({ sendAccountDeletionCompleteEmail: vi.fn() }));
vi.mock('@bike4mind/server-utils/analytics/signupEvents', () => ({ emitBillingEvent: vi.fn() }));
// Customer IDs are resolved for real; only the Stripe calls are stubbed, recording what each cancel would bill.
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/integrations/stripe/stripe')>()),
  isStripeConfigured: () => true,
}));
const billed = vi.hoisted(() => new Map<string, readonly string[]>());
vi.mock('@bike4mind/server-utils/billing/cancelAccountSubscriptions', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/server-utils/billing/cancelAccountSubscriptions')>();
  return {
    ...actual,
    cancelAccountSubscriptions: vi.fn(async (input: { userId: string; customerIds?: readonly string[] }) => {
      billed.set(input.userId, input.customerIds ?? (await actual.readAccountSubscriptionCustomerIds(input.userId)));
      return { canceled: [], failed: [] };
    }),
  };
});
vi.mock('@bike4mind/server-utils/services/cdn/invalidateRouterCdn', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/services/cdn/invalidateRouterCdn')>()),
  createCdnInvalidationBatch: () => ({ add: vi.fn(), flush: vi.fn() }),
}));
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return { ...actual, authSessionService: { ...actual.authSessionService, endRealtimeConnections: vi.fn() } };
});

import { completeAccountDeletion } from '@bike4mind/server-utils/users/completeAccountDeletion';
import { erasureIdHash } from '@bike4mind/server-utils/privacy/erasureHash';
import { reapplyErasure } from '../users/reapplyErasure';
import { erasureRegistry } from './erasureRegistry';
import { DELETED_USER_ID } from './placeholder';
import { SubjectErasurePlan } from './subjectErasurePlan';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const { ObjectId } = mongoose.Types;
let database: MongoMemoryReplSet;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});

/** Casts through the schema, then writes raw so required fields and hooks do not get in the way. */
async function insert(model: string, doc: Record<string, unknown>) {
  const Model = mongoose.model(model);
  const cast = new Model(doc).toObject({ depopulate: true });
  await Model.collection.insertOne(cast);
  return cast._id as InstanceType<typeof ObjectId>;
}

const TEAM_SCOPED_MODELS = [
  Session.modelName,
  'AgentExecution',
  'LatticeModel',
  'QuestExternalLink',
  'ResearchData',
  'ResearchTask',
  'WorkItem',
];

async function seedAccount(source: 'self' | 'admin' = 'admin') {
  const subject = new ObjectId();
  const admin = new ObjectId();
  const other = new ObjectId();
  const userId = String(subject);
  const now = new Date();
  await insert('User', {
    _id: subject,
    username: `erase-${userId}`,
    email: `erase-${userId}@example.test`,
    deletion: {
      requestedAt: new Date(now.getTime() - 60_000),
      scheduledFor: now,
      source,
      ...(source === 'admin' ? { requestedBy: String(admin) } : {}),
    },
  });
  await insert('User', { _id: admin, username: `admin-${admin}`, email: `admin-${admin}@example.test` });
  await insert('User', {
    _id: other,
    username: `other-${other}`,
    email: `other-${other}@example.test`,
    referredByUserId: userId,
    throttle: { changedBy: userId },
    signupLanding: { notebookOwnerId: userId },
  });

  const shared = await insert('Organization', {
    name: 'Shared',
    userId: String(other),
    personal: false,
    users: [
      { userId: String(other), role: 'owner' },
      { userId, role: 'member' },
    ],
    adminUserIds: [userId],
  });
  await insert('Organization', {
    name: 'Tombstoned',
    userId,
    billingContact: `erase-${userId}@example.test`,
    personal: false,
    deletedAt: new Date(now.getTime() - 3_600_000),
    users: [{ userId, role: 'owner' }],
  });
  await insert('Organization', { name: 'Personal', userId, personal: true, users: [{ userId, role: 'owner' }] });

  await insert('AdminUserNote', { userId, body: 'about the subject', author: { id: String(admin), name: 'Admin' } });
  await insert('AdminUserNote', {
    userId: String(other),
    body: 'written by the subject',
    author: { id: userId, name: 'Subject' },
  });
  await insert('AdminUserNoteRevision', {
    userId,
    noteId: new ObjectId(),
    body: 'rev',
    author: { id: String(admin), name: 'Admin' },
  });
  await insert('CounterLog', { userId, userName: 'Subject', key: 'personal', count: 1 });
  await insert('CounterLog', { userId, userName: 'Subject', key: 'org', organizationId: String(shared), count: 1 });
  await insert('Inbox', { receiverId: userId, userId: String(other), message: 'received' });
  await insert('Inbox', { receiverId: String(other), userId, message: 'sent' });
  await insert('Project', { name: 'Personal project', userId });
  await insert('Project', { name: 'Org project', userId, organizationId: String(shared) });
  const agentId = `agent-${userId}`;
  await insert('DeepAgentCharter', { identity: { ownerUserId: userId, agentId } });
  await insert('DeepAgentEpisode', { agentId });
  await insert('GitHubLakeAuthGrant', { userId });
  await insert('CreditTransaction', { ownerId: userId, ownerType: 'User', type: 'purchase', credits: 10 });
  // Rows the account purge used to delete itself and now leaves to the registry erasure.
  await insert('AuthSession', { userId });
  await insert('ApiKey', { userId, type: 'openai', apiKey: 'ciphertext', deletedAt: new Date() });
  await insert('UserActivityCounter', { userId });
  await insert('FeedbackNote', { userId, body: 'private account note' });
  await insert('Friendship', { requester: userId, recipient: String(other) });
  await insert('McpConnection', { ownerType: 'user', ownerKey: userId, userId, slug: 'mine' });
  await insert('GenerationJob', { ownerType: 'User', ownerId: userId });
  await insert('Activity', { ownerType: 'User', ownerId: userId });
  await insert('TaskSchedule', { payload: { userId } });
  await insert('DataLakeAccessGrant', {
    dataLakeId: 'lake',
    principalType: 'user',
    principalId: userId,
    role: 'reader',
  });
  const sharedNotebook = await insert(Session.modelName, { userId: String(other), users: [{ userId }] });
  // The person's rows in a team organization stay with it; their personal copies go.
  const teamRows: { model: string; personal: InstanceType<typeof ObjectId>; team: InstanceType<typeof ObjectId> }[] =
    [];
  for (const model of TEAM_SCOPED_MODELS) {
    teamRows.push({
      model,
      personal: await insert(model, { userId }),
      team: await insert(model, { userId, organizationId: String(shared) }),
    });
  }
  // Soft-deleted rows still name the person and must go too.
  await insert('Project', { name: 'Trashed project', userId, deletedAt: new Date() });
  await insert('DeepAgentEpisode', { agentId, deletedAt: new Date() });
  return { userId, email: `erase-${userId}@example.test`, sharedNotebook, teamRows, other: String(other), shared };
}

describe('admin erasure against the real data holder registry', () => {
  it('leaves nothing naming the user outside the stated retentions, and no unclassified model', async () => {
    const { userId, sharedNotebook, teamRows } = await seedAccount();
    await expect(completeAccountDeletion(userId, { logger: logger as never, erasureRegistry })).resolves.toEqual({
      deleted: true,
    });
    const entry = await AdminAuditLogModel.findOne({ action: ADMIN_ERASURE_COMPLETED_ACTION, 'target.id': userId })
      .lean<{
        details: { remaining: { model: string; deleted: number; anonymized: number }[]; unclassified: string[] };
      }>()
      .exec();
    expect(entry).not.toBeNull();
    expect(entry!.details.unclassified).toEqual([]);
    const remaining = entry!.details.remaining.map(({ model, deleted, anonymized }) => ({
      model,
      deleted,
      anonymized,
    }));
    expect(remaining).toEqual([]);
    expect(await mongoose.model(Session.modelName).collection.findOne({ _id: sharedNotebook })).toMatchObject({
      users: [],
    });
    for (const { model, personal, team } of teamRows) {
      const collection = mongoose.model(model).collection;
      expect(await collection.findOne({ _id: personal }), model).toBeNull();
      const kept = await collection.findOne({ _id: team });
      expect(kept, model).not.toBeNull();
      expect(String(kept!.userId), model).not.toBe(userId);
    }
  });

  it('deletes the messages the person sent, which no receiver could be shown once the sender is gone', async () => {
    const { userId, other } = await seedAccount();
    await expect(completeAccountDeletion(userId, { logger: logger as never, erasureRegistry })).resolves.toEqual({
      deleted: true,
    });
    expect(await inboxRepository.findByReceiverId(other)).toEqual([]);
    expect(await mongoose.model('Inbox').collection.countDocuments({ receiverId: other })).toBe(0);
  });

  it('erases a personal file with its chunks and leaves a team file and its chunks in place', async () => {
    const { userId, shared } = await seedAccount();
    const personalFile = await insert('FabFile', { userId, fileName: 'personal.txt' });
    const teamFile = await insert('FabFile', { userId, fileName: 'team.txt', organizationId: String(shared) });
    const personalChunk = await insert('FabFileChunk', { fabFileId: String(personalFile), text: 'mine' });
    const teamChunk = await insert('FabFileChunk', { fabFileId: String(teamFile), text: 'team' });

    await expect(completeAccountDeletion(userId, { logger: logger as never, erasureRegistry })).resolves.toEqual({
      deleted: true,
    });

    const files = mongoose.model('FabFile').collection;
    const chunks = mongoose.model('FabFileChunk').collection;
    expect(await files.findOne({ _id: personalFile })).toBeNull();
    expect(await chunks.findOne({ _id: personalChunk })).toBeNull();
    const kept = await files.findOne({ _id: teamFile });
    expect(kept).not.toBeNull();
    expect(String(kept!.userId)).not.toBe(userId);
    expect(await chunks.findOne({ _id: teamChunk })).not.toBeNull();
  });
});

/** What the registry finds naming a subject once their account is gone, per collection. */
async function leftNaming(subject: { userId: string; email: string }) {
  const collections = await new SubjectErasurePlan(subject).collections();
  return collections.map(({ model, deleted, anonymized, retained }) => ({ model, deleted, anonymized, retained }));
}

describe('self-serve deletion and admin erasure', () => {
  it('leave the same rows naming the person from identical accounts', async () => {
    const self = await seedAccount('self');
    const admin = await seedAccount('admin');
    for (const { userId } of [self, admin]) {
      await expect(completeAccountDeletion(userId, { logger: logger as never, erasureRegistry })).resolves.toEqual({
        deleted: true,
      });
    }

    for (const subject of [self, admin]) {
      await expect(erasureRegistry.audit(subject)).resolves.toEqual({ remaining: [], unclassified: [] });
    }
    const [selfLeft, adminLeft] = await Promise.all([leftNaming(self), leftNaming(admin)]);
    // The admin path alone records the erasure check (user.erasure.completed) against the person's id.
    const withoutAuditLog = (rows: Awaited<ReturnType<typeof leftNaming>>) =>
      rows.filter(row => row.model !== 'AdminAuditLog');
    expect(withoutAuditLog(selfLeft)).toEqual(withoutAuditLog(adminLeft));
    expect(withoutAuditLog(selfLeft).length).toBeGreaterThan(0);
    const auditRows = (rows: Awaited<ReturnType<typeof leftNaming>>) =>
      rows.find(row => row.model === 'AdminAuditLog')?.retained ?? 0;
    expect(auditRows(adminLeft)).toBe(auditRows(selfLeft) + 1);
  });
});

describe('a sole-owned paid organization tombstoned before the purge', () => {
  it.each(['self', 'admin'] as const)(
    'is billed by the %s completion cancel and loses its owner once the user row is gone, and again on replay',
    async source => {
      const { userId } = await seedAccount(source);
      const stripeCustomerId = `cus_${userId}`;
      const paid = await insert('Organization', {
        name: 'Paid',
        userId,
        stripeCustomerId,
        personal: false,
        deletedAt: new Date(Date.now() - 3_600_000),
        users: [{ userId, role: 'owner' }],
      });

      await expect(completeAccountDeletion(userId, { logger: logger as never, erasureRegistry })).resolves.toEqual({
        deleted: true,
      });
      expect(billed.get(userId)).toEqual([stripeCustomerId]);
      const organizations = mongoose.model('Organization').collection;
      expect(String((await organizations.findOne({ _id: paid }))!.userId)).toBe(DELETED_USER_ID);

      // A restore brings back the row and the owner link; replay must anonymize it again.
      await insert('User', {
        _id: new mongoose.Types.ObjectId(userId),
        username: `restored-${userId}`,
        deletion: { requestedAt: new Date(), scheduledFor: new Date(), source },
      });
      await organizations.updateOne({ _id: paid }, { $set: { userId } });
      const record = (await ErasureRecordModel.findOne({ idHash: erasureIdHash(userId) }).lean())!;
      await reapplyErasure(userId, { record, logger: logger as never });
      expect(String((await organizations.findOne({ _id: paid }))!.userId)).toBe(DELETED_USER_ID);
    }
  );
});
