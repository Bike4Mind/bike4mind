import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  Connection,
  QuerySubscription,
  ErasureRecordModel,
  Organization,
  Session,
  User,
  FeedbackModel,
  FeedbackAiModel,
  FeedbackNoteModel,
  OrgAdminNotificationPrefModel,
  OrgAlertNotificationModel,
  Inbox,
  erasureRecordRepository,
  realtimeConnectionRepository,
} from '@bike4mind/database';
import { erasureIdHash } from '@bike4mind/server-utils/privacy/erasureHash';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { JWT_SECRET: 'test-jwt-secret' } }));
const effects = vi.hoisted(() => ({
  storage: vi.fn(),
  cancel: vi.fn(),
  billingEvent: vi.fn(),
  email: vi.fn(),
  purge: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getGeneratedImageStorage: () => ({ delete: effects.storage, deletePermanently: effects.storage }),
  getPublishedArtifactsStorage: () => ({ deletePrefix: effects.storage, deletePrefixPermanently: effects.storage }),
  getFilesStorage: () => ({
    delete: effects.storage,
    deletePermanently: effects.storage,
    deletePrefix: effects.storage,
    deletePrefixPermanently: effects.storage,
  }),
  getAppFilesStorage: () => ({ delete: effects.storage, deletePermanently: effects.storage }),
}));
vi.mock('@bike4mind/server-utils/services/publish/purgeUserPublishedArtifacts', () => ({
  purgeUserPublishedArtifacts: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/skillMarket/market', () => ({ withdrawAuthorListings: vi.fn() }));
vi.mock('@bike4mind/server-utils/auth/signupNetworkLimits', () => ({ retainDeletedSignupTraces: vi.fn() }));
vi.mock('@bike4mind/server-utils/analytics/signupEvents', () => ({ emitBillingEvent: effects.billingEvent }));
vi.mock('@bike4mind/server-utils/users/accountDeletionEmail', () => ({
  sendAccountDeletionCompleteEmail: effects.email,
}));
// Spy, not replace: the revokes are called from inside this module, so only the arguments can show them skipped.
vi.mock('@bike4mind/server-utils/services/purgeDeletedUserData', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/server-utils/services/purgeDeletedUserData')>();
  effects.purge.mockImplementation(actual.purgeDeletedUserData);
  return { ...actual, purgeDeletedUserData: effects.purge };
});
vi.mock('@bike4mind/server-utils/billing/cancelAccountSubscriptions', () => ({
  cancelAccountSubscriptions: effects.cancel,
  readAccountSubscriptionCustomerIds: vi.fn(async () => []),
  SINGLE_USER_CANCEL_BUDGET_MS: 1000,
  NO_SUBSCRIPTIONS_CANCELED: { canceled: [], failed: [] },
}));

import { hardDeleteUser } from '@bike4mind/server-utils/services/hardDeleteUser';
import { reapplyErasure } from './reapplyErasure';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let database: MongoMemoryReplSet;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const raw = (model: { collection: { name: string } }) => mongoose.connection.collection(model.collection.name);

beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
beforeEach(async () => {
  vi.clearAllMocks();
  effects.cancel.mockResolvedValue({ canceled: [], failed: [] });
  for (const name of mongoose.modelNames())
    await mongoose.connection.collection(mongoose.model(name).collection.name).deleteMany({});
});

/** Seeds an account with a personal org and a notebook; returns a function that puts the same rows back. */
async function seedAccount() {
  const userId = new mongoose.Types.ObjectId();
  const orgId = new mongoose.Types.ObjectId();
  const reportId = new mongoose.Types.ObjectId();
  const createdAt = new Date();
  const expiresAt = new Date(Date.now() + 86400000);
  const insertRows = async () => {
    await raw(User).insertOne({ _id: userId, username: `u-${userId}`, email: `u-${userId}@example.test` });
    await raw(FeedbackModel).updateOne(
      { _id: reportId },
      { $set: { userId: String(userId), username: 'Reporter', status: 'New', createdAt } },
      { upsert: true }
    );
    await raw(FeedbackAiModel).updateOne(
      { feedbackId: String(reportId) },
      {
        $set: {
          inputHash: 'hash',
          model: 'test-embedding',
          vector: [1],
          similar: [],
          reportCreatedAt: createdAt,
          expiresAt,
        },
      },
      { upsert: true }
    );
    await raw(FeedbackNoteModel).updateOne(
      { feedbackId: String(reportId) },
      {
        $set: {
          userId: String(userId),
          author: { id: 'moderator', name: 'Moderator' },
          body: 'Private note',
          createdAt,
          expiresAt,
        },
      },
      { upsert: true }
    );
    await raw(OrgAdminNotificationPrefModel).updateOne(
      { userId: String(userId) },
      { $set: { organizationId: 'team', kinds: {} } },
      { upsert: true }
    );
    await raw(OrgAlertNotificationModel).updateOne(
      { subjectUserId: String(userId) },
      { $set: { organizationId: 'team', scope: `user:${userId}`, kind: 'member_cap', periodKey: '2026-11' } },
      { upsert: true }
    );
    await raw(Inbox).updateOne(
      { receiverId: String(userId), organizationAlert: true },
      { $set: { message: 'org alert' } },
      { upsert: true }
    );
    await raw(Organization).insertOne({ _id: orgId, name: 'Personal', userId: String(userId), personal: true });
    await raw(Session).insertOne({
      _id: new mongoose.Types.ObjectId(),
      userId: String(userId),
      name: 'chat',
      organizationId: String(orgId),
    });
  };
  await insertRows();
  return { id: String(userId), insertRows };
}
/** The restore overwrites the erased account's rows with their pre-erasure state. */
const restoreAccount = async (id: string, insertRows: () => Promise<void>) => {
  await raw(User).deleteMany({ _id: new mongoose.Types.ObjectId(id) });
  await raw(Organization).deleteMany({ userId: id });
  await raw(Session).deleteMany({ userId: id });
  await insertRows();
};
const rowCounts = async () => ({
  users: await raw(User).countDocuments(),
  orgs: await raw(Organization).countDocuments(),
  sessions: await raw(Session).countDocuments(),
});

describe('reapplyErasure after a simulated restore', () => {
  it.each(['self', 'admin'] as const)('re-erases a %s-erased account and sends nothing', async initiatedBy => {
    const { id, insertRows } = await seedAccount();
    const bystander = await seedAccount();
    await hardDeleteUser(id, { deletedBy: id, initiatedBy, logger }, users => users.delete(id));
    const record = await ErasureRecordModel.findOne({ idHash: erasureIdHash(id) }).lean();
    expect(record?.initiatedBy).toBe(initiatedBy);
    expect(JSON.stringify(record)).not.toContain(id);

    // The restore: the user row (and, for a self erasure that removed them, its content) come back.
    await ErasureRecordModel.deleteMany({}); // the restored database has no record of the erasure
    await restoreAccount(id, insertRows);
    vi.clearAllMocks();
    await raw(Connection).insertMany([
      { connectionId: 'erased-connection', userId: id },
      { connectionId: 'bystander-connection', userId: bystander.id },
    ]);
    await raw(QuerySubscription).insertOne({
      collectionName: 'sessions',
      queryId: 'restored-query',
      subscribers: [{ connectionId: 'erased-connection' }, { connectionId: 'bystander-connection' }],
    });

    const result = await reapplyErasure(id, { record: record!, logger });

    expect(result.ownedOrganizationIds).toEqual([]);
    expect(await FeedbackAiModel.countDocuments()).toBe(1);
    expect(await FeedbackNoteModel.countDocuments()).toBe(1);
    expect(await OrgAdminNotificationPrefModel.countDocuments({ userId: id })).toBe(0);
    expect(await OrgAlertNotificationModel.countDocuments({ subjectUserId: id })).toBe(0);
    expect(await Inbox.collection.countDocuments({ receiverId: id, organizationAlert: true })).toBe(0);
    expect(await OrgAdminNotificationPrefModel.countDocuments({ userId: bystander.id })).toBe(1);
    expect(await OrgAlertNotificationModel.countDocuments({ subjectUserId: bystander.id })).toBe(1);
    expect(await Inbox.collection.countDocuments({ receiverId: bystander.id, organizationAlert: true })).toBe(1);
    expect((await raw(Connection).findOne({ connectionId: 'erased-connection' }))?.endedAt).toBeInstanceOf(Date);
    expect((await raw(Connection).findOne({ connectionId: 'bystander-connection' }))?.endedAt).toBeUndefined();
    expect((await raw(QuerySubscription).findOne({ queryId: 'restored-query' }))?.subscribers).toEqual([
      { connectionId: 'bystander-connection' },
    ]);
    // The repeat leaves the restored database holding the record again.
    expect(await ErasureRecordModel.countDocuments({ idHash: record!.idHash })).toBe(1);
    const counts = await rowCounts();
    // The bystander keeps every row. A self erasure removed content and the personal org; an admin one
    // never did, so neither does the repeat.
    const mine = initiatedBy === 'self' ? 0 : 1;
    expect(counts).toEqual({ users: 1, orgs: 1 + mine, sessions: 1 + mine });
    expect(await raw(User).countDocuments({ _id: new mongoose.Types.ObjectId(id) })).toBe(0);
    expect(await raw(User).countDocuments({ _id: new mongoose.Types.ObjectId(bystander.id) })).toBe(1);
    expect(await raw(Organization).countDocuments({ userId: id })).toBe(mine);
    expect(await raw(Organization).countDocuments({ userId: bystander.id })).toBe(1);
    expect(await raw(Session).countDocuments({ userId: bystander.id })).toBe(1);
    expect(effects.cancel).not.toHaveBeenCalled();
    expect(effects.billingEvent).not.toHaveBeenCalled();
    expect(effects.email).not.toHaveBeenCalled();
    expect(effects.purge).toHaveBeenCalledTimes(1);
    expect(effects.purge).toHaveBeenCalledWith(id, expect.objectContaining({ integrationGrants: null }));
  });

  it('reports a non-personal organisation the restored account still owned, by org id', async () => {
    const { id, insertRows } = await seedAccount();
    await hardDeleteUser(id, { deletedBy: id, initiatedBy: 'admin', logger }, users => users.delete(id));
    const record = (await ErasureRecordModel.findOne({ idHash: erasureIdHash(id) }).lean())!;
    await restoreAccount(id, insertRows);
    const teamOrg = new mongoose.Types.ObjectId();
    await raw(Organization).insertOne({ _id: teamOrg, name: 'Team', userId: id, personal: false, deletedAt: null });

    const result = await reapplyErasure(id, { record, logger });
    expect(result.ownedOrganizationIds).toEqual([String(teamOrg)]);
  });

  it.each(['self', 'admin'] as const)('ends a %s account connection opened during the purge', async initiatedBy => {
    const { id, insertRows } = await seedAccount();
    await hardDeleteUser(id, { deletedBy: id, initiatedBy, logger }, users => users.delete(id));
    const record = (await ErasureRecordModel.findOne({ idHash: erasureIdHash(id) }).lean())!;
    await restoreAccount(id, insertRows);
    const endConnections = realtimeConnectionRepository.endConnections;
    const spy = vi.spyOn(realtimeConnectionRepository, 'endConnections').mockImplementationOnce(async filter => {
      const result = await endConnections(filter);
      await raw(Connection).insertOne({ connectionId: 'late-connection', userId: id });
      await raw(QuerySubscription).insertOne({
        collectionName: 'sessions',
        queryId: 'late-query',
        subscribers: [{ connectionId: 'late-connection' }],
      });
      return result;
    });
    try {
      await reapplyErasure(id, { record, logger });
      expect((await raw(Connection).findOne({ connectionId: 'late-connection' }))?.endedAt).toBeInstanceOf(Date);
      expect(await raw(QuerySubscription).countDocuments({ queryId: 'late-query' })).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it.each(['self', 'admin'] as const)(
    'keeps the %s account retryable when realtime cleanup fails',
    async initiatedBy => {
      const { id, insertRows } = await seedAccount();
      await hardDeleteUser(id, { deletedBy: id, initiatedBy, logger }, users => users.delete(id));
      const record = (await ErasureRecordModel.findOne({ idHash: erasureIdHash(id) }).lean())!;
      await restoreAccount(id, insertRows);
      const spy = vi
        .spyOn(realtimeConnectionRepository, 'endConnections')
        .mockRejectedValueOnce(new Error('prune failed'));
      try {
        await expect(reapplyErasure(id, { record, logger })).rejects.toThrow('prune failed');
        expect(await raw(User).countDocuments({ _id: new mongoose.Types.ObjectId(id) })).toBe(1);
        await reapplyErasure(id, { record, logger });
        expect(await raw(User).countDocuments({ _id: new mongoose.Types.ObjectId(id) })).toBe(0);
      } finally {
        spy.mockRestore();
      }
    }
  );

  it('reports a partial erasure when realtime cleanup fails after the delete committed', async () => {
    const { id, insertRows } = await seedAccount();
    await hardDeleteUser(id, { deletedBy: id, initiatedBy: 'self', logger }, users => users.delete(id));
    const record = (await ErasureRecordModel.findOne({ idHash: erasureIdHash(id) }).lean())!;
    await restoreAccount(id, insertRows);
    effects.purge.mockClear();
    const spy = vi
      .spyOn(realtimeConnectionRepository, 'endConnections')
      .mockResolvedValueOnce({ connectionIds: [] })
      .mockRejectedValueOnce(new Error('post-delete prune failed'));
    try {
      await expect(reapplyErasure(id, { record, logger })).rejects.toThrow('post-delete prune failed');
      expect(await raw(User).countDocuments({ _id: new mongoose.Types.ObjectId(id) })).toBe(0);
      expect(effects.purge).toHaveBeenCalledExactlyOnceWith(id, expect.objectContaining({ integrationGrants: null }));
    } finally {
      spy.mockRestore();
    }
  });

  it.each(['self', 'admin'] as const)('keeps the %s account when the record write fails', async initiatedBy => {
    const { id, insertRows } = await seedAccount();
    await hardDeleteUser(id, { deletedBy: id, initiatedBy, logger }, users => users.delete(id));
    const record = (await ErasureRecordModel.findOne({ idHash: erasureIdHash(id) }).lean())!;
    await ErasureRecordModel.deleteMany({});
    await restoreAccount(id, insertRows);
    const spy = vi.spyOn(erasureRecordRepository, 'record').mockRejectedValueOnce(new Error('write failed'));
    try {
      await expect(reapplyErasure(id, { record, logger })).rejects.toThrow('write failed');
    } finally {
      spy.mockRestore();
    }
    // The delete rolled back with the failed write: no row gone without its record.
    expect(await raw(User).countDocuments({ _id: new mongoose.Types.ObjectId(id) })).toBe(1);
    expect(await ErasureRecordModel.countDocuments({ idHash: record.idHash })).toBe(0);
    if (initiatedBy === 'admin') {
      expect(await OrgAdminNotificationPrefModel.countDocuments({ userId: id })).toBe(1);
      expect(await OrgAlertNotificationModel.countDocuments({ subjectUserId: id })).toBe(1);
      expect(await Inbox.collection.countDocuments({ receiverId: id, organizationAlert: true })).toBe(1);
    }
  });
});
