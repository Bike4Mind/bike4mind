import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ADMIN_ERASURE_COMPLETED_ACTION } from '@bike4mind/common';
import { AdminAuditLogModel, mongoose } from '@bike4mind/database';
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
vi.mock('@bike4mind/server-utils/users/purgeAccountFiles', () => ({ purgeAccountFiles: vi.fn() }));
vi.mock('@bike4mind/server-utils/users/accountDeletionEmail', () => ({ sendAccountDeletionCompleteEmail: vi.fn() }));
vi.mock('@bike4mind/server-utils/analytics/signupEvents', () => ({ emitBillingEvent: vi.fn() }));
vi.mock('@bike4mind/server-utils/billing/cancelAccountSubscriptions', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/billing/cancelAccountSubscriptions')>()),
  readAccountSubscriptionCustomerIds: vi.fn(async () => []),
  cancelAccountSubscriptions: vi.fn(async () => ({ canceled: [], failed: [] })),
}));
vi.mock('@bike4mind/server-utils/services/cdn/invalidateRouterCdn', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/services/cdn/invalidateRouterCdn')>()),
  createCdnInvalidationBatch: () => ({ add: vi.fn(), flush: vi.fn() }),
}));
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return { ...actual, authSessionService: { ...actual.authSessionService, endRealtimeConnections: vi.fn() } };
});

import { completeAccountDeletion } from '@bike4mind/server-utils/users/completeAccountDeletion';
import { erasureRegistry } from './erasureRegistry';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * Collections the registry still finds naming an erased admin-requested subject after the purge, as
 * the purge stands today. Each entry is a place the registry and the account purge disagree.
 */
const KNOWN_RESIDUAL: { model: string; deleted: number; anonymized: number }[] = [
  // The message the person sent: the purge deletes only what they received.
  { model: 'Inbox', deleted: 0, anonymized: 1 },
  // The tombstone memoryPrincipalKeyRepository.destroy keeps as a fence; the registry deletes the row.
  { model: 'MemoryPrincipalKey', deleted: 1, anonymized: 0 },
  // The tombstoned organization they owned keeps its userId and billingContact.
  { model: 'Organization', deleted: 0, anonymized: 1 },
  // The organization-owned project, which the registry deletes and the purge leaves.
  { model: 'Project', deleted: 1, anonymized: 0 },
  // Another account's referredByUserId, throttle.changedBy and signupLanding.notebookOwnerId.
  { model: 'User', deleted: 0, anonymized: 1 },
];

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

async function seedAccount() {
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
      source: 'admin',
      requestedBy: String(admin),
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
  // Soft-deleted rows still name the person and must go too.
  await insert('Project', { name: 'Trashed project', userId, deletedAt: new Date() });
  await insert('DeepAgentEpisode', { agentId, deletedAt: new Date() });
  return { userId };
}

describe('admin erasure against the real data holder registry', () => {
  it('leaves only the known residual and no unclassified model', async () => {
    const { userId } = await seedAccount();
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
    expect(remaining).toEqual(KNOWN_RESIDUAL);
  });
});
