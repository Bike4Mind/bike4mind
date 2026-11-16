import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  FabFile,
  OrganizationGeneratedObject,
  OrganizationRetentionEstimate,
  Organization,
  User,
  Session,
} from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, { get: (_, key) => ({ value: `test-${String(key)}` }) }),
}));

const effects = vi.hoisted(() => ({
  deleteGenerated: vi.fn(),
  deletePrefix: vi.fn(),
  deleteFile: vi.fn(),
  sendCompleteEmail: vi.fn(),
  cdnAdd: vi.fn(),
  cdnFlush: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getGeneratedImageStorage: () => ({ delete: effects.deleteGenerated, deletePermanently: effects.deleteGenerated }),
  getPublishedArtifactsStorage: () => ({
    deletePrefix: effects.deletePrefix,
    deletePrefixPermanently: effects.deletePrefix,
  }),
  getFilesStorage: () => ({
    delete: effects.deleteFile,
    deletePermanently: effects.deleteFile,
    deletePrefix: effects.deletePrefix,
    deletePrefixPermanently: effects.deletePrefix,
  }),
  getAppFilesStorage: () => ({ delete: effects.deleteFile, deletePermanently: effects.deleteFile }),
}));
vi.mock('@bike4mind/server-utils/services/cdn/invalidateRouterCdn', async importActual => ({
  ...(await importActual<typeof import('@bike4mind/server-utils/services/cdn/invalidateRouterCdn')>()),
  createCdnInvalidationBatch: () => ({ add: effects.cdnAdd, flush: effects.cdnFlush }),
}));
vi.mock('@bike4mind/server-utils/services/publish/purgeUserPublishedArtifacts', () => ({
  purgeUserPublishedArtifacts: vi.fn(),
  unpublishUserArtifactsBySource: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/skillMarket/market', () => ({ withdrawAuthorListings: vi.fn() }));
vi.mock('@bike4mind/server-utils/auth/signupNetworkLimits', () => ({ retainDeletedSignupTraces: vi.fn() }));
vi.mock('@bike4mind/server-utils/analytics/signupEvents', () => ({ emitBillingEvent: vi.fn() }));
vi.mock('@bike4mind/server-utils/users/accountDeletionEmail', () => ({
  sendAccountDeletionCompleteEmail: effects.sendCompleteEmail,
}));
vi.mock('@bike4mind/server-utils/billing/cancelAccountSubscriptions', () => ({
  cancelAccountSubscriptions: vi.fn(async () => ({ canceled: [], failed: [] })),
  readAccountSubscriptionCustomerIds: vi.fn(async () => []),
  SINGLE_USER_CANCEL_BUDGET_MS: 1000,
  NO_SUBSCRIPTIONS_CANCELED: { canceled: [], failed: [] },
}));

import { completeAccountDeletion, type ErasureRegistry } from '@bike4mind/server-utils/users/completeAccountDeletion';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let database: MongoMemoryReplSet;
const ownerId = new mongoose.Types.ObjectId().toString();
const otherOwnerId = new mongoose.Types.ObjectId().toString();
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const collection = (name: string) => mongoose.connection.collection(mongoose.model(name).collection.name);

beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
beforeEach(async () => {
  vi.clearAllMocks();
  effects.deleteGenerated.mockResolvedValue(undefined);
  effects.deletePrefix.mockResolvedValue(undefined);
  effects.deleteFile.mockResolvedValue(undefined);
  effects.sendCompleteEmail.mockResolvedValue(undefined);
  for (const modelName of mongoose.modelNames()) await collection(modelName).deleteMany({});
});

// These purges are self-serve, so the erasure registry is never consulted.
const erasureRegistry: ErasureRegistry = {
  scope: async () => [],
  audit: async () => ({ remaining: [], unclassified: [] }),
};

import { cleanupOrganizationRetention } from './retentionCleanup';

describe('retention ownership through actual account deletion and later organization cleanup', () => {
  it('erases the personal original and creator while preserving org files and ledger-only media for their own sweep', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 2 * 86400_000);
    const orgId = new mongoose.Types.ObjectId();
    const originId = new mongoose.Types.ObjectId();
    const privateId = new mongoose.Types.ObjectId();
    const fileId = new mongoose.Types.ObjectId();
    const organizationKey = '12345678-1234-1234-1234-123456789abc.png';
    const privateKey = 'fedcbafe-dcba-fedc-bafe-dcbafedcbafe.png';
    const objects = new Set([organizationKey, privateKey, 'team-upload']);
    effects.deleteGenerated.mockImplementation(async (key: string) => {
      objects.delete(key);
    });
    effects.deleteFile.mockImplementation(async (key: string) => {
      objects.delete(key);
    });
    await User.collection.insertMany([
      {
        _id: new mongoose.Types.ObjectId(ownerId),
        username: 'departing-member',
        email: 'member@example.test',
        createdAt: old,
        deletion: { requestedAt: old, scheduledFor: new Date(now.getTime() - 1000), source: 'self' },
      },
      { _id: new mongoose.Types.ObjectId(otherOwnerId), username: 'retained-owner', email: 'owner@example.test' },
    ]);
    await Organization.create({
      _id: orgId,
      name: 'Surviving team',
      userId: otherOwnerId,
      personal: false,
      users: [{ userId: ownerId }],
      retentionVersion: 1,
      retentionPolicy: { chats: null, files: 1, media: 1 },
      currentStorageSize: 1000,
    });
    await Session.collection.insertMany([
      {
        _id: originId,
        userId: ownerId,
        name: 'personal original billed to team',
        retentionOrganizationId: String(orgId),
      },
      { _id: privateId, userId: ownerId, name: 'personal private original' },
    ]);
    await collection('Quest').insertMany([
      { sessionId: String(originId), images: [organizationKey], timestamp: old },
      { sessionId: String(privateId), images: [privateKey], timestamp: old },
    ]);
    await FabFile.collection.insertOne({
      _id: fileId,
      userId: ownerId,
      organizationId: String(orgId),
      fileName: 'team.txt',
      filePath: 'team-upload',
      fileSize: 10,
      storageChargedAt: old,
      createdAt: old,
      deletedAt: null,
      users: [],
      tags: [],
    });
    await OrganizationGeneratedObject.create({
      key: organizationKey,
      organizationId: String(orgId),
      userId: ownerId,
      sessionId: String(originId),
      createdAt: old,
    });
    await OrganizationRetentionEstimate.create({
      token: '12345678-1234-1234-1234-123456789abc',
      organizationId: String(orgId),
      actorUserId: ownerId,
      version: 1,
      policy: { chats: 1, files: null, media: null },
      counts: { chats: 0, files: 0, media: 0 },
      estimatedAt: now,
      expiresAt: new Date(now.getTime() + 600_000),
    });
    await expect(completeAccountDeletion(ownerId, { logger, erasureRegistry, now })).resolves.toEqual({
      deleted: true,
    });
    expect(await User.exists({ _id: ownerId })).toBeNull();
    expect(await Session.collection.findOne({ _id: originId })).toBeNull();
    expect(await FabFile.exists({ _id: fileId })).not.toBeNull();
    expect(await OrganizationGeneratedObject.findOne({ key: organizationKey }).lean()).toMatchObject({
      organizationId: String(orgId),
      userId: 'deleted-account',
      sessionId: String(originId),
    });
    expect(await OrganizationRetentionEstimate.countDocuments({ actorUserId: ownerId })).toBe(0);
    expect(objects).toEqual(new Set([organizationKey, 'team-upload']));
    expect(await cleanupOrganizationRetention(String(orgId), { now })).toEqual({ chats: 0, files: 1, media: 1 });
    expect(objects.size).toBe(0);
    expect((await Organization.findById(orgId).lean())?.currentStorageSize).toBe(990);
    expect(await cleanupOrganizationRetention(String(orgId), { now })).toEqual({ chats: 0, files: 0, media: 0 });
    expect((await Organization.findById(orgId).lean())?.currentStorageSize).toBe(990);
    expect(await User.exists({ _id: otherOwnerId })).not.toBeNull();
  });
});
