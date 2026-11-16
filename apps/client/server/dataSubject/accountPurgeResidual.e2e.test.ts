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
import { SubjectErasureExecutor } from './subjectErasureExecutor';
import { SubjectRecordExport } from './subjectRecordExport';
import { aiHolders } from './registry/ai';
import { DATA_HOLDER_REGISTRY } from './registry';
import { purgePersonalLakeById } from '@bike4mind/server-utils/users/purgeAccountContent';

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

describe('retained organization creators', () => {
  it('keeps organization Agents and same-name Skills while removing personal copies and creator memberships', async () => {
    const first = await seedAccount('self');
    const second = await seedAccount('self');
    const name = `shared-${new ObjectId()}`;
    const retained: { model: string; id: InstanceType<typeof ObjectId>; organizationId: string }[] = [];
    const personal: { model: string; id: InstanceType<typeof ObjectId> }[] = [];
    await mongoose.model('Skill').createIndexes();
    for (const { userId } of [first, second]) {
      const organizationId = String(new ObjectId());
      for (const model of ['Agent', 'Skill']) {
        retained.push({
          model,
          organizationId,
          id: await insert(model, {
            name,
            userId,
            organizationId,
            users: [{ userId }],
            description: 'organization content',
          }),
        });
        personal.push({ model, id: await insert(model, { name: `personal-${userId}`, userId }) });
      }
      await completeAccountDeletion(userId, { logger, erasureRegistry });
    }
    for (const { model, id, organizationId } of retained) {
      const row = await mongoose.model(model).collection.findOne({ _id: id });
      expect(row).not.toBeNull();
      expect(row!.name).toBe(name);
      expect(String(row!.organizationId)).toBe(organizationId);
      expect([first.userId, second.userId]).not.toContain(String(row!.userId));
      expect(row!.users).toEqual([]);
    }
    for (const { model, id } of personal)
      expect(await mongoose.model(model).collection.findOne({ _id: id })).toBeNull();
    expect(await mongoose.model('Skill').collection.countDocuments({ name })).toBe(2);
  });
});

describe('final organization cleanup commits with deletion', () => {
  it.each(['self', 'admin'] as const)(
    'keeps the %s retry anchor on a cleanup write failure and succeeds on retry',
    async source => {
      const { userId, email } = await seedAccount(source);
      const organizations = mongoose.model('Organization').collection;
      const original = await organizations.findOne({ userId, personal: false, deletedAt: { $ne: null } });
      const database = mongoose.connection.db!;
      const collection = database.collection(organizations.name);
      const bulkWrite = collection.bulkWrite.bind(collection);
      const originalCollection = database.collection.bind(database);
      const collectionLookup = vi
        .spyOn(database, 'collection')
        .mockImplementation((name, options) =>
          name === organizations.name ? collection : originalCollection(name, options)
        );
      const failure = vi.spyOn(collection, 'bulkWrite').mockImplementation(async (operations, options) => {
        if (options?.session) throw new Error('final organization cleanup unavailable');
        return bulkWrite(operations, options);
      });
      try {
        await expect(completeAccountDeletion(userId, { logger, erasureRegistry })).rejects.toThrow(
          'final organization cleanup unavailable'
        );
      } finally {
        failure.mockRestore();
        collectionLookup.mockRestore();
      }
      expect(await mongoose.model('User').exists({ _id: userId })).not.toBeNull();
      expect(await ErasureRecordModel.findOne({ idHash: erasureIdHash(userId) })).toBeNull();
      const retained = await organizations.findOne({ _id: original!._id });
      expect(String(retained!.userId)).toBe(userId);
      expect(retained!.billingContact).toBe(email);
      await expect(completeAccountDeletion(userId, { logger, erasureRegistry })).resolves.toEqual({ deleted: true });
      expect(await mongoose.model('User').exists({ _id: userId })).toBeNull();
      expect(await ErasureRecordModel.findOne({ idHash: erasureIdHash(userId) })).not.toBeNull();
      expect(String((await organizations.findOne({ _id: original!._id }))!.userId)).toBe(DELETED_USER_ID);
    }
  );
});

describe('canonical personal lake ownership', () => {
  it.each([
    'creator',
    'transferred-out',
    'co-owned',
    'expired-owner',
    'transferred-in',
    'organization',
    'personal-workspace',
  ] as const)('uses the same %s admission for export and erasure', async kind => {
    const userId = String(new ObjectId());
    const other = String(new ObjectId());
    const workspace = kind === 'personal-workspace' ? await insert('Organization', { userId, personal: true }) : null;
    const organizationId = kind === 'organization' ? String(new ObjectId()) : workspace ? String(workspace) : null;
    const id = await insert('DataLake', {
      createdByUserId: kind === 'transferred-in' ? other : userId,
      organizationId,
      name: 'private lake body',
      datalakeTag: `lake-${new ObjectId()}`,
    });
    const owners =
      kind === 'transferred-out' || kind === 'expired-owner'
        ? [other]
        : kind === 'co-owned'
          ? [userId, other]
          : kind === 'transferred-in'
            ? [userId]
            : [];
    for (const principalId of owners)
      await insert('DataLakeAccessGrant', {
        dataLakeId: String(id),
        principalType: 'user',
        principalId,
        role: 'owner',
        grantedByUserId: other,
        ...(kind === 'expired-owner' ? { expiresAt: new Date(Date.now() - 1_000) } : {}),
      });
    const registry = { DataLake: aiHolders.DataLake };
    const subject = { userId, email: null };
    const exporter = new SubjectRecordExport(subject, registry);
    const records = [];
    for await (const record of exporter.records('DataLake')) records.push(record);
    const owned = ['creator', 'expired-owner', 'transferred-in', 'personal-workspace'].includes(kind);
    expect(records).toHaveLength(1);
    if (owned) expect(records[0].name).toBe('private lake body');
    else expect(records[0]).not.toHaveProperty('name');
    await new SubjectErasureExecutor(subject, async () => {}, registry).run();
    expect((await mongoose.model('DataLake').collection.findOne({ _id: id })) !== null).toBe(!owned);
    expect(await mongoose.model('DataLakeAccessGrant').collection.countDocuments({ dataLakeId: String(id) })).toBe(
      owned ? 0 : owners.length
    );
  });

  it('re-resolves ownership after a real concurrent transfer wins the write conflict', async () => {
    const userId = String(new ObjectId());
    const other = String(new ObjectId());
    const id = await insert('DataLake', {
      createdByUserId: userId,
      name: 'retained',
      datalakeTag: `lake-${new ObjectId()}`,
    });
    const child = await insert('DataLakeFinding', { dataLakeId: String(id), title: 'retained content' });
    let checkpoints = 0;
    let transferred = false;
    const checkpoint = async () => {
      checkpoints += 1;
      if (transferred || checkpoints !== 3) return;
      transferred = true;
      const session = await mongoose.connection.startSession();
      try {
        await session.withTransaction(async () => {
          await mongoose.model('DataLakeAccessGrant').collection.insertOne(
            {
              dataLakeId: String(id),
              principalType: 'user',
              principalId: other,
              role: 'owner',
              grantedByUserId: userId,
            },
            { session }
          );
          await mongoose
            .model('DataLake')
            .collection.updateOne({ _id: id }, { $currentDate: { updatedAt: true } }, { session });
        });
      } finally {
        await session.endSession();
      }
    };
    expect(await purgePersonalLakeById(userId, String(id), checkpoint)).toBe(false);
    expect(transferred).toBe(true);
    expect(checkpoints).toBeGreaterThan(3);
    expect(await mongoose.model('DataLake').collection.findOne({ _id: id })).not.toBeNull();
    expect(await mongoose.model('DataLakeFinding').collection.findOne({ _id: child })).not.toBeNull();
  });

  it('rolls back memory, content and grants when the lease is lost during the cascade', async () => {
    const userId = String(new ObjectId());
    const tag = `lake-${new ObjectId()}`;
    const id = await insert('DataLake', { createdByUserId: userId, name: 'retry', datalakeTag: tag });
    const child = await insert('DataLakeFinding', { dataLakeId: String(id), title: 'retry content' });
    const grant = await insert('DataLakeAccessGrant', {
      dataLakeId: String(id),
      principalType: 'user',
      principalId: userId,
      role: 'owner',
      grantedByUserId: userId,
    });
    let checkpoints = 0;
    await expect(
      purgePersonalLakeById(userId, String(id), async () => {
        if (++checkpoints === 10) throw new Error('lease lost');
      })
    ).rejects.toThrow('lease lost');
    for (const [model, rowId] of [
      ['DataLake', id],
      ['DataLakeFinding', child],
      ['DataLakeAccessGrant', grant],
    ] as const)
      expect(await mongoose.model(model).collection.findOne({ _id: rowId })).not.toBeNull();
    expect(
      await mongoose.model('MemoryPrincipalKey').collection.findOne({ principalKind: 'lake', principalId: tag })
    ).toBeNull();
    expect(await purgePersonalLakeById(userId, String(id), async () => {})).toBe(true);
    expect(await mongoose.model('DataLake').collection.findOne({ _id: id })).toBeNull();
  });
});

describe('file family authority', () => {
  it('preserves a parent and its actual chunk after a planned personal file joins an organization lake', async () => {
    const userId = String(new ObjectId());
    const tag = `team-${new ObjectId()}`;
    await insert('DataLake', {
      createdByUserId: String(new ObjectId()),
      organizationId: String(new ObjectId()),
      datalakeTag: tag,
      name: 'team',
    });
    const file = await insert('FabFile', { userId, fileName: 'team.txt', tags: [{ name: 'notes' }] });
    const chunk = await insert('FabFileChunk', { fabFileId: String(file), text: 'team text' });
    const personal = await insert('FabFile', { userId, fileName: 'personal.txt' });
    const personalChunk = await insert('FabFileChunk', { fabFileId: String(personal), text: 'personal text' });
    const registry = { FabFile: DATA_HOLDER_REGISTRY.FabFile, FabFileChunk: DATA_HOLDER_REGISTRY.FabFileChunk };
    const original = SubjectErasurePlan.prototype.collections;
    const spy = vi.spyOn(SubjectErasurePlan.prototype, 'collections').mockImplementation(function (
      this: SubjectErasurePlan,
      checkpoint,
      sink
    ) {
      return original.call(this, checkpoint, async (model, entries) => {
        if (model === 'FabFile') {
          expect(entries.find(entry => String(entry.document._id) === String(file))?.outcome).toBe('deleted');
          await mongoose.model('FabFile').collection.updateOne({ _id: file }, { $push: { tags: { name: tag } } });
        }
        await sink?.(model, entries);
      });
    });
    try {
      await new SubjectErasureExecutor({ userId, email: null }, async () => {}, registry).run();
    } finally {
      spy.mockRestore();
    }
    expect(String((await mongoose.model('FabFile').collection.findOne({ _id: file }))!.userId)).toBe(DELETED_USER_ID);
    expect(await mongoose.model('FabFileChunk').collection.findOne({ _id: chunk })).not.toBeNull();
    expect(await mongoose.model('FabFile').collection.findOne({ _id: personal })).toBeNull();
    expect(await mongoose.model('FabFileChunk').collection.findOne({ _id: personalChunk })).toBeNull();
  });

  it('rolls back a file and its chunks together if the lease is lost after child deletion', async () => {
    const userId = String(new ObjectId());
    const file = await insert('FabFile', { userId, fileName: 'retry.txt' });
    const chunk = await insert('FabFileChunk', { fabFileId: String(file), text: 'retry text' });
    const registry = { FabFile: DATA_HOLDER_REGISTRY.FabFile, FabFileChunk: DATA_HOLDER_REGISTRY.FabFileChunk };
    const checkpoint = async () => {
      // ALS makes this observation read the actual deletion's snapshot.
      const parent = await mongoose.model('FabFile').findById(file);
      const child = await mongoose.model('FabFileChunk').findById(chunk);
      if (parent && !child) throw new Error('lease lost after child delete');
    };
    await expect(new SubjectErasureExecutor({ userId, email: null }, checkpoint, registry).run()).rejects.toThrow(
      'lease lost after child delete'
    );
    expect(await mongoose.model('FabFile').collection.findOne({ _id: file })).not.toBeNull();
    expect(await mongoose.model('FabFileChunk').collection.findOne({ _id: chunk })).not.toBeNull();
    await new SubjectErasureExecutor({ userId, email: null }, async () => {}, registry).run();
    expect(await mongoose.model('FabFile').collection.findOne({ _id: file })).toBeNull();
    expect(await mongoose.model('FabFileChunk').collection.findOne({ _id: chunk })).toBeNull();
  });
});

describe('retained content settlement', () => {
  it('anonymizes creator attribution when ownership transfers after the lake plan', async () => {
    const userId = String(new ObjectId());
    const other = String(new ObjectId());
    const id = await insert('DataLake', {
      createdByUserId: userId,
      lastUpdatedByUserId: userId,
      datalakeTag: `lake-${new ObjectId()}`,
      name: 'transferred content',
    });
    const child = await insert('DataLakeFinding', { dataLakeId: String(id), title: 'retained content' });
    const original = SubjectErasurePlan.prototype.collections;
    const spy = vi.spyOn(SubjectErasurePlan.prototype, 'collections').mockImplementation(function (
      this: SubjectErasurePlan,
      checkpoint,
      sink
    ) {
      return original.call(this, checkpoint, async (model, entries) => {
        if (model === 'DataLake') {
          await insert('DataLakeAccessGrant', {
            dataLakeId: String(id),
            principalType: 'user',
            principalId: other,
            role: 'owner',
            grantedByUserId: other,
          });
          await mongoose.model('DataLake').collection.updateOne({ _id: id }, { $currentDate: { updatedAt: true } });
        }
        await sink?.(model, entries);
      });
    });
    try {
      await new SubjectErasureExecutor({ userId, email: null }, async () => {}, { DataLake: aiHolders.DataLake }).run();
    } finally {
      spy.mockRestore();
    }
    const lake = await mongoose.model('DataLake').collection.findOne({ _id: id });
    expect(lake!.name).toBe('transferred content');
    expect(lake!.createdByUserId).not.toBe(userId);
    expect(lake!.createdByUserId).not.toBe(other);
    expect(lake!.createdByUserId).toMatch(/^[a-f0-9]{24}$/);
    expect(lake!.lastUpdatedByUserId).toBe(DELETED_USER_ID);
    expect(await mongoose.model('DataLakeFinding').collection.findOne({ _id: child })).not.toBeNull();
  });

  it('commits owner cleanup before a self-service postcommit cancellation error', async () => {
    const { userId } = await seedAccount('self');
    const organizations = mongoose.model('Organization').collection;
    const owner = await organizations.findOne({ userId, personal: false, deletedAt: { $ne: null } });
    const { cancelAccountSubscriptions } = await import('@bike4mind/server-utils/billing/cancelAccountSubscriptions');
    vi.mocked(cancelAccountSubscriptions).mockRejectedValueOnce(new Error('postcommit cancellation failed'));
    await expect(completeAccountDeletion(userId, { logger, erasureRegistry })).rejects.toThrow(
      'postcommit cancellation failed'
    );
    expect(await mongoose.model('User').exists({ _id: userId })).toBeNull();
    expect(await ErasureRecordModel.findOne({ idHash: erasureIdHash(userId) })).not.toBeNull();
    expect(String((await organizations.findOne({ _id: owner!._id }))!.userId)).toBe(DELETED_USER_ID);
  });
});
