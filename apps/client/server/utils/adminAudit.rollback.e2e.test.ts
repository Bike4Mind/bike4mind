import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import type { AdminAuditAction, AuditContext, IAdminAuditLogRepository } from '@bike4mind/common';
import {
  AdminAuditLogModel,
  adminAuditLogRepository,
  userRepository,
  User,
  withTransaction,
} from '@bike4mind/database';
import { AdminSettings } from '@bike4mind/database/infra';
import { adminAuditService } from '@bike4mind/services';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// A strict (critical) action and its audit entry commit together or not at all. A standalone mongod
// cannot run transactions, so only a replica set can tell a rolled-back write from one that escaped.

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

const context: AuditContext = { source: 'admin_ui', route: '/api/test' };
const actor = { kind: 'user' as const, scope: 'platform' as const, userId: 'admin-1', name: 'Admin', wasAdmin: true };

const failingStore: Pick<IAdminAuditLogRepository, 'append'> = {
  append: () => Promise.reject(new Error('audit store unavailable')),
};

const record = (action: AdminAuditAction, store: Pick<IAdminAuditLogRepository, 'append'>, targetId: string) =>
  adminAuditService.recordAdminAction(
    { action, actor, context, target: { kind: 'user', id: targetId, displayName: 'Target' }, summary: 'test' },
    { db: { adminAuditLog: store }, logger: { error: () => undefined } }
  );

const seedUser = async (isAdmin = false) =>
  User.create({
    name: 'Target',
    username: `target-${Math.random().toString(36).slice(2, 10)}`,
    password: null,
    hasUsablePassword: false,
    isAdmin,
  });

const isAdminNow = async (id: string) => (await User.findById(id).lean())?.isAdmin;

describe('strict admin audit writes roll back the action on a real replica set', () => {
  it('a failed audit write leaves a role grant uncommitted', async () => {
    const user = await seedUser();

    await expect(
      withTransaction(async () => {
        await User.updateOne({ _id: user._id }, { $set: { isAdmin: true } });
        await record('user.role.admin_granted', failingStore, user.id);
      })
    ).rejects.toThrow('audit store unavailable');

    expect(await isAdminNow(user.id)).toBe(false);
    expect(await AdminAuditLogModel.countDocuments()).toBe(0);
  });

  it('a failed audit write leaves a user deletion uncommitted', async () => {
    const user = await seedUser();

    await expect(
      withTransaction(async () => {
        await userRepository.delete(user.id);
        await record('user.deleted', failingStore, user.id);
      })
    ).rejects.toThrow('audit store unavailable');

    expect(await userRepository.findById(user.id)).not.toBeNull();
  });

  it('a failed audit write leaves an admin settings edit uncommitted', async () => {
    await AdminSettings.create({ settingName: 'EnableUserDeletionSlackNotification', settingValue: false });

    await expect(
      withTransaction(async () => {
        await AdminSettings.findOneAndUpdate(
          { settingName: 'EnableUserDeletionSlackNotification' },
          { $set: { settingValue: true } }
        );
        await record('settings.admin_settings.updated', failingStore, 'EnableUserDeletionSlackNotification');
      })
    ).rejects.toThrow('audit store unavailable');

    const stored = await AdminSettings.findOne({ settingName: 'EnableUserDeletionSlackNotification' }).lean();
    expect(stored?.settingValue).toBe(false);
  });

  it('an entry the real store rejects also rolls the action back', async () => {
    const user = await seedUser();

    await expect(
      withTransaction(async () => {
        await User.updateOne({ _id: user._id }, { $set: { isAdmin: true } });
        // An empty summary fails schema validation inside the same session.
        await adminAuditService.recordAdminAction(
          {
            action: 'user.role.admin_granted',
            actor,
            context,
            target: { kind: 'user', id: user.id, displayName: 'Target' },
            summary: '',
          },
          { db: { adminAuditLog: adminAuditLogRepository } }
        );
      })
    ).rejects.toThrow();

    expect(await isAdminNow(user.id)).toBe(false);
  });

  it('commits the action and its entry together when the audit write succeeds', async () => {
    const user = await seedUser();

    await withTransaction(async () => {
      await User.updateOne({ _id: user._id }, { $set: { isAdmin: true } });
      await record('user.role.admin_granted', adminAuditLogRepository, user.id);
    });

    expect(await isAdminNow(user.id)).toBe(true);
    expect(await AdminAuditLogModel.countDocuments({ action: 'user.role.admin_granted', 'target.id': user.id })).toBe(
      1
    );
  });

  it('a best-effort action still commits when its audit write fails', async () => {
    const user = await seedUser(true);

    await withTransaction(async () => {
      await User.updateOne({ _id: user._id }, { $set: { name: 'Renamed' } });
      await record('user.impersonation.ended', failingStore, user.id);
    });

    expect((await User.findById(user.id).lean())?.name).toBe('Renamed');
  });
});
