import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { OrganizationAuditEventModel, User } from '@bike4mind/database';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';
const h = vi.hoisted(() => ({ erase: vi.fn(), prefix: vi.fn(), content: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ deletePermanently: h.erase, deletePrefixPermanently: h.prefix }),
}));
vi.mock('@bike4mind/server-utils/users/purgeAccountContent', () => ({ purgeAccountContent: h.content }));
vi.mock('@bike4mind/server-utils/users/accountDeletionEmail', () => ({ sendAccountDeletionCompleteEmail: vi.fn() }));
vi.mock('@bike4mind/server-utils/services/cdn/invalidateRouterCdn', () => ({
  createCdnInvalidationBatch: () => ({ add: vi.fn(), flush: async () => {} }),
}));
vi.mock('@bike4mind/services', async original => {
  const actual = await original<typeof import('@bike4mind/services')>();
  return { ...actual, authSessionService: { endRealtimeConnections: vi.fn() } };
});
vi.mock('@bike4mind/server-utils/services/hardDeleteUser', () => ({
  hardDeleteUser: async (userId: string, context: { assertInTransaction: () => Promise<void> }) => {
    await context.assertInTransaction();
    await User.deleteOne({ _id: userId });
  },
}));
import { claimAccountExportLease } from './accountExportLease';
import { claimAccountFilePurgeLease } from '@bike4mind/server-utils/users/accountFilePurgeLease';
import { purgeAccountFiles } from '@bike4mind/server-utils/users/purgeAccountFiles';
import { completeAccountDeletion } from '@bike4mind/server-utils/users/completeAccountDeletion';
import { legacyOrganizationExportKey } from '@bike4mind/server-utils/utils/organizationDataExport';
import exportIndexMigration from '../../../../packages/scripts/migrate/migrations/20261114125931_ensure-organization-export-erasure-index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let database: MongoMemoryReplSet;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const noCallerLease = async () => {};
const versions = new Map<string, string[]>();
beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await OrganizationAuditEventModel.createIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
beforeEach(() => {
  vi.clearAllMocks();
  versions.clear();
  h.erase.mockImplementation(async (key: string) => {
    versions.delete(key);
  });
  h.prefix.mockResolvedValue(undefined);
});
async function seedUser(due = false) {
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id,
    username: `export-${_id}`,
    email: `export-${_id}@example.test`,
    ...(due ? { deletion: { requestedAt: new Date(0), scheduledFor: new Date(0), source: 'self' } } : {}),
  });
  return String(_id);
}
const complete = (userId: string) =>
  completeAccountDeletion(userId, {
    logger,
    erasureRegistry: { scope: async () => [], audit: async () => ({ remaining: [], unclassified: [] }) },
  });

describe('shared export and strict erasure fences with Mongo', () => {
  it('installs the actor/action/cursor serving index idempotently through the real migration', async () => {
    await exportIndexMigration.up();
    await exportIndexMigration.up();
    const indexes = await OrganizationAuditEventModel.collection.indexes();
    expect(indexes.find(index => index.name === 'organization_export_erasure_locators')?.key).toEqual({
      actorUserId: 1,
      action: 1,
      _id: 1,
    });
  });

  it('reconciles a delayed successful PUT when deletion becomes due before its response', async () => {
    const userId = await seedUser();
    const lease = await claimAccountExportLease(userId, randomUUID());
    const erase = vi.fn(async () => {});
    const uploadFile = vi.fn(async () => {
      await User.updateOne(
        { _id: userId },
        {
          $set: {
            deletion: {
              requestedAt: new Date(0),
              scheduledFor: new Date(0),
              source: 'self',
            },
          },
        }
      );
    });
    await expect(
      lease!.upload({
        storage: { uploadFile, deletePermanently: erase },
        key: 'exact-key',
        localPath: '/tmp/export.zip',
        remainingMs: () => 600_000,
        logger,
      })
    ).rejects.toThrow('lease lost after upload');
    expect(erase).toHaveBeenCalledWith('exact-key');
    await lease!.release();
  });

  it('keeps the renewed real Mongo lease after an ambiguous PUT even when exact cleanup fails', async () => {
    const userId = await seedUser();
    const lease = await claimAccountExportLease(userId, randomUUID());
    const failure = new Error('PUT response lost');
    const uploadFile = vi.fn(async () => {
      throw failure;
    });
    const erase = vi.fn(async () => {
      throw new Error('delete unavailable');
    });
    await expect(
      lease!.upload({
        storage: { uploadFile, deletePermanently: erase },
        key: 'exact-key',
        localPath: '/tmp/export.zip',
        remainingMs: () => 600_000,
        logger,
      })
    ).rejects.toBe(failure);
    await lease!.release();
    const user = await User.findById(userId).select('+accountDataExportLease').lean();
    expect(user?.accountDataExportLease?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 19 * 60_000);
    await expect(claimAccountFilePurgeLease(userId, noCallerLease, logger)).rejects.toThrow('busy');
  });

  it.each(['first', 'retry'] as const)(
    'the actual export claim prevents the %s deletion claim until it expires',
    async phase => {
      const userId = await seedUser();
      const lease = await claimAccountExportLease(userId, randomUUID());
      expect(lease).not.toBeNull();
      await User.updateOne(
        { _id: userId },
        {
          $set: {
            deletion: {
              requestedAt: new Date(0),
              scheduledFor: new Date(0),
              source: 'self',
              ...(phase === 'retry' ? { purgeStartedAt: new Date(0), purgeLeaseExpiresAt: new Date(0) } : {}),
            },
          },
        }
      );
      await expect(complete(userId)).resolves.toEqual({ deleted: false, reason: 'busy' });
      await User.updateOne({ _id: userId }, { $set: { 'accountDataExportLease.expiresAt': new Date(0) } });
      await expect(complete(userId)).resolves.toEqual({ deleted: true });
      expect(await User.exists({ _id: userId })).toBeNull();
    }
  );

  it('fences exports permanently on a restored User without inventing a deletion schedule', async () => {
    const userId = await seedUser();
    const exportLease = await claimAccountExportLease(userId, randomUUID());
    await expect(claimAccountFilePurgeLease(userId, noCallerLease, logger)).rejects.toThrow('busy');
    await exportLease!.release();
    const purge = await claimAccountFilePurgeLease(userId, noCallerLease, logger);
    await expect(claimAccountExportLease(userId, randomUUID())).resolves.toBeNull();
    await expect(claimAccountFilePurgeLease(userId, noCallerLease, logger)).rejects.toThrow('busy');
    await purge.release();
    await expect(claimAccountExportLease(userId, randomUUID())).resolves.toBeNull();
    const user = await User.findById(userId).select('+accountFilePurge').lean();
    expect(user?.deletion).toBeUndefined();
    expect(user?.accountFilePurge?.startedAt).toBeInstanceOf(Date);
  });

  it('resumes past 50 successful legacy deletes and preserves immutable audit locators', async () => {
    const userId = await seedUser(true);
    const rows = Array.from({ length: 101 }, (_, index) => ({
      organizationId: index % 2 ? 'A'.repeat(24) : 'b'.repeat(24),
      actorUserId: userId,
      action: 'export.requested' as const,
      targetId: randomUUID(),
      occurredAt: new Date(),
    }));
    await OrganizationAuditEventModel.insertMany(rows);
    const before = await OrganizationAuditEventModel.find({ actorUserId: userId }).sort({ _id: 1 }).lean();
    const keys = before.map(row => legacyOrganizationExportKey(row.organizationId, userId, row.targetId!));
    for (const key of keys) versions.set(key, ['current', 'older-version']);
    const foreign = legacyOrganizationExportKey('a'.repeat(24), 'another-user', randomUUID());
    versions.set(foreign, ['foreign']);
    h.erase.mockImplementation(async (key: string) => {
      if (key === keys[50]) throw new Error('row 51 storage failure');
      versions.delete(key);
    });
    await expect(complete(userId)).rejects.toThrow('row 51');
    const progress = await User.findById(userId).select('+accountFilePurge').lean();
    expect(progress?.accountFilePurge?.afterAuditId).toBe(String(before[49]._id));
    expect(await User.exists({ _id: userId })).not.toBeNull();
    const priorDeletes = h.erase.mock.calls.length;
    h.erase.mockImplementation(async (key: string) => {
      versions.delete(key);
    });
    await expect(complete(userId)).resolves.toEqual({ deleted: true });
    expect(h.erase.mock.calls.slice(priorDeletes).map(([key]) => key)).toEqual(keys.slice(50));
    expect([...versions]).toEqual([[foreign, ['foreign']]]);
    expect(await OrganizationAuditEventModel.find({ actorUserId: userId }).sort({ _id: 1 }).lean()).toEqual(before);
    expect(h.prefix).toHaveBeenCalledWith(`exports/organization-data/${userId}/`);
  });

  it('refuses an old invocation checkpoint after token replacement', async () => {
    const userId = await seedUser();
    const purge = await claimAccountFilePurgeLease(userId, noCallerLease, logger);
    const progress = await purge.initialize();
    await User.updateOne({ _id: userId }, { $set: { 'accountFilePurge.leaseId': 'replacement' } });
    await expect(purge.advance(progress, new mongoose.Types.ObjectId().toString(), false)).rejects.toThrow(
      'lease lost'
    );
    await purge.release();
    expect((await User.findById(userId).select('+accountFilePurge').lean())?.accountFilePurge?.leaseId).toBe(
      'replacement'
    );
  });

  it('repeats only the uncheckpointed object if its lease is replaced during storage deletion', async () => {
    const userId = await seedUser();
    const row = await OrganizationAuditEventModel.create({
      organizationId: 'a'.repeat(24),
      actorUserId: userId,
      action: 'export.requested',
      targetId: randomUUID(),
    });
    const key = legacyOrganizationExportKey(row.organizationId, userId, row.targetId!);
    h.erase.mockImplementationOnce(async () => {
      await User.updateOne(
        { _id: userId },
        {
          $set: {
            'accountFilePurge.leaseId': 'replacement',
            'accountFilePurge.leaseExpiresAt': new Date(0),
          },
        }
      );
    });
    await expect(purgeAccountFiles(userId, { logger, assertLease: noCallerLease })).rejects.toThrow('lease lost');
    expect(
      (await User.findById(userId).select('+accountFilePurge').lean())?.accountFilePurge?.afterAuditId
    ).toBeUndefined();
    await purgeAccountFiles(userId, { logger, assertLease: noCallerLease });
    expect(h.erase.mock.calls.map(([erasedKey]) => erasedKey)).toEqual([key, key]);
  });

  it('retains the original upper audit boundary across retries', async () => {
    const userId = await seedUser();
    const row = await OrganizationAuditEventModel.create({
      organizationId: 'a'.repeat(24),
      actorUserId: userId,
      action: 'export.requested',
      targetId: randomUUID(),
    });
    const first = await claimAccountFilePurgeLease(userId, noCallerLease, logger);
    const original = await first.initialize();
    await first.release();
    await OrganizationAuditEventModel.create({
      organizationId: 'b'.repeat(24),
      actorUserId: userId,
      action: 'export.requested',
      targetId: randomUUID(),
    });
    const retry = await claimAccountFilePurgeLease(userId, noCallerLease, logger);
    expect(await retry.initialize()).toEqual(original);
    expect(original.throughAuditId).toBe(String(row._id));
    await retry.release();
  });

  it('retains the retry anchor and cursor when an audit locator is malformed', async () => {
    const userId = await seedUser();
    await OrganizationAuditEventModel.create({
      organizationId: '../neighbor',
      actorUserId: userId,
      action: 'export.requested',
      targetId: randomUUID(),
    });
    await expect(purgeAccountFiles(userId, { logger, assertLease: noCallerLease })).rejects.toThrow();
    expect(h.erase).not.toHaveBeenCalled();
    const user = await User.findById(userId).select('+accountFilePurge').lean();
    expect(user?.accountFilePurge).toMatchObject({ initialized: true, complete: false });
    expect(user?.accountFilePurge?.afterAuditId).toBeUndefined();
    expect(user?.accountFilePurge?.leaseId).toBeUndefined();
  });

  it('does not remove bytes or invent a retry anchor for a missing User', async () => {
    await expect(
      purgeAccountFiles(new mongoose.Types.ObjectId().toString(), { logger, assertLease: noCallerLease })
    ).rejects.toThrow('retry anchor is missing');
    expect(h.erase).not.toHaveBeenCalled();
    expect(h.prefix).not.toHaveBeenCalled();
  });
});
