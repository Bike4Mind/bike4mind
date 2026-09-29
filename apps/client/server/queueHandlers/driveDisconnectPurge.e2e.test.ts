import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

// Only the app-layer edges are mocked: Google (the revoke), crypto, the object store, the memory
// ledger and SQS. The repositories, markDisconnecting and release run against a real mongod.
vi.mock('@server/utils/config', () => ({
  Config: { GOOGLE_CLIENT_ID: 'test-client-id', GOOGLE_CLIENT_SECRET: 'test-client-secret' },
}));
vi.mock('@server/security/tokenEncryption', () => ({
  encryptToken: (v?: string | null) => (v ? `enc(${v})` : null),
  decryptToken: (v?: string | null) => {
    if (!v) return null;
    const m = /^enc\((.*)\)$/.exec(v);
    if (!m) throw new Error('Token decryption failed');
    return m[1];
  },
}));
const h = vi.hoisted(() => ({ revokeToken: vi.fn(), storageDelete: vi.fn(async () => undefined) }));
vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        revokeToken = h.revokeToken;
        generateAuthUrl = () => 'https://auth';
        getToken = vi.fn();
        setCredentials = vi.fn();
        refreshAccessToken = vi.fn();
      },
    },
  },
}));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ delete: h.storageDelete }) }));
vi.mock('@server/dataLakes/shredMemoryForLakeTags', () => ({ shredMemoryForLakeTags: vi.fn() }));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: vi.fn() }));
vi.mock('sst', () => ({ Resource: { driveDisconnectPurgeQueue: { url: 'purge-queue-url' } } }));

import {
  DataLakeModel,
  FabFile,
  FabFileChunk,
  OrgGoogleDriveConnection,
  orgGoogleDriveConnectionRepository,
  userRepository,
} from '@bike4mind/database';
import { KnowledgeType } from '@bike4mind/common';
import { runDriveDisconnectPurge, type DriveDisconnectPurgePayload } from './driveDisconnectPurge';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  await OrgGoogleDriveConnection.ensureIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  await FabFile.deleteMany({}, { hardDelete: true } as Record<string, unknown>);
  await FabFileChunk.deleteMany({});
  await OrgGoogleDriveConnection.deleteMany({}, { hardDelete: true } as Record<string, unknown>);
  await DataLakeModel.deleteMany({});
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const OWNER = '5f9d88b8c1d2a30017a1c333';
const ORG = '5f9d88b8c1d2a30017a1b111';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const seed = async (driveFileCount: number) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const lake = await DataLakeModel.create({
    name: 'Drive Lake',
    slug: `drive-lake-${suffix}`,
    fileTagPrefix: `drive-${suffix}:`,
    datalakeTag: `datalake:drive-lake-${suffix}`,
    createdByUserId: OWNER,
    organizationId: ORG,
    status: 'active',
  });
  const conn = await OrgGoogleDriveConnection.create({
    organizationId: ORG,
    authMode: 'oauth',
    driveFolderId: `folder-${suffix}`,
    targetDataLakeId: lake.id,
    connectedBy: OWNER,
    oauthRefreshToken: 'enc(org-refresh)',
  });
  const makeFile = (driveConnectionId?: string) =>
    FabFile.create({
      userId: OWNER,
      fileName: `file-${Math.random().toString(36).slice(2)}.txt`,
      type: KnowledgeType.FILE,
      status: 'complete',
      fileSize: 100,
      filePath: `files/${new mongoose.Types.ObjectId().toHexString()}`,
      tags: [{ name: lake.datalakeTag, strength: 1 }],
      ...(driveConnectionId ? { driveConnectionId } : {}),
    });
  for (let i = 0; i < driveFileCount; i++) await makeFile(conn.id);
  const manual = await makeFile();
  return { lake, conn, manual };
};

/** Drains a simulated queue: every message the consumer enqueues is delivered in turn. */
const drain = async (first: DriveDisconnectPurgePayload, sliceSize: number, redeliverFirst = false) => {
  const queue: DriveDisconnectPurgePayload[] = redeliverFirst ? [first, first] : [first];
  const outcomes: string[] = [];
  while (queue.length > 0) {
    const message = queue.shift()!;
    outcomes.push(
      await runDriveDisconnectPurge(message, { logger, sliceSize, enqueue: async next => void queue.push(next) })
    );
    if (outcomes.length > 50) throw new Error('purge did not converge');
  }
  return outcomes;
};

describe('Drive disconnect purge via the queue (real repos + Mongo)', () => {
  it('works through a connection larger than one invocation slice by slice, then releases it', async () => {
    const { lake, conn, manual } = await seed(5);
    // The route's half: mark first, then the message.
    const marked = await orgGoogleDriveConnectionRepository.markDisconnecting(conn.id, ORG);
    expect(marked?.created).toBe(true);
    const payload = { connectionId: conn.id, dataLakeId: lake.id, organizationId: ORG };

    const outcomes = await drain(payload, 2);

    expect(outcomes).toEqual(['continued', 'continued', 'released']);
    expect(
      await FabFile.countDocuments({ driveConnectionId: conn.id }, { includeDeleted: true } as Record<string, unknown>)
    ).toBe(0);
    expect(await FabFile.countDocuments({ _id: manual.id })).toBe(1);
    expect(await OrgGoogleDriveConnection.findById(conn.id)).toBeNull();
    expect((await DataLakeModel.findById(lake.id))?.fileCount).toBe(1);

    // A late redelivery after release is a no-op.
    expect(await runDriveDisconnectPurge(payload, { logger, sliceSize: 2, enqueue: async () => {} })).toBe('dropped');
  });

  it('re-stamps the pending disconnect on every run, so a progressing purge never reads as stalled', async () => {
    const { lake, conn } = await seed(3);
    const marked = await orgGoogleDriveConnectionRepository.markDisconnecting(conn.id, ORG);
    await new Promise(resolve => setTimeout(resolve, 5));
    const payload = { connectionId: conn.id, dataLakeId: lake.id, organizationId: ORG };

    expect(await runDriveDisconnectPurge(payload, { logger, sliceSize: 1, enqueue: async () => {} })).toBe('continued');
    const row = await OrgGoogleDriveConnection.findById(conn.id);
    expect(row!.disconnectRequestedAt!.getTime()).toBeGreaterThan(marked!.stamp.getTime());
  });

  it('converges under a redelivered message without refunding any owner twice', async () => {
    const { lake, conn } = await seed(4);
    await orgGoogleDriveConnectionRepository.markDisconnecting(conn.id, ORG);
    const refunds: number[] = [];
    vi.spyOn(userRepository, 'incrementCurrentStorage').mockImplementation(async (_userId, delta) => {
      refunds.push(delta);
    });
    const payload = { connectionId: conn.id, dataLakeId: lake.id, organizationId: ORG };

    // Two copies of the first message run concurrently, the overlap a visibility-timeout
    // redelivery produces; each re-resolves the remaining files from the DB.
    const [a, b] = await Promise.all([
      runDriveDisconnectPurge(payload, { logger, sliceSize: 3, enqueue: async () => {} }),
      runDriveDisconnectPurge(payload, { logger, sliceSize: 3, enqueue: async () => {} }),
    ]);
    expect([a, b]).toContain('continued');
    await drain(payload, 3);

    expect(await FabFile.countDocuments({ driveConnectionId: conn.id })).toBe(0);
    expect(await OrgGoogleDriveConnection.findById(conn.id)).toBeNull();
    expect(refunds.reduce((sum, delta) => sum + delta, 0)).toBe(-400);
  });

  it('leaves the row, still marked disconnecting, when a slice fails, so a retry resumes it', async () => {
    const { lake, conn } = await seed(3);
    await orgGoogleDriveConnectionRepository.markDisconnecting(conn.id, ORG);
    h.storageDelete.mockRejectedValueOnce(new Error('storage.delete blip'));
    const payload = { connectionId: conn.id, dataLakeId: lake.id, organizationId: ORG };

    await expect(runDriveDisconnectPurge(payload, { logger, sliceSize: 10, enqueue: async () => {} })).rejects.toThrow(
      'storage.delete blip'
    );
    const row = await OrgGoogleDriveConnection.findById(conn.id);
    expect(row?.disconnectRequestedAt).toBeInstanceOf(Date);
    expect(row?.enabled).toBe(false);

    expect(await drain(payload, 10)).toEqual(['released']);
    expect(await FabFile.countDocuments({ driveConnectionId: conn.id })).toBe(0);
  });
});
