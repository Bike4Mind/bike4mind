import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

// Only the edges the app layer owns are mocked - the crypto helpers and the Google client. The
// repositories, the models and the unique index they build are REAL, which is the point: every unit
// layer around this seam mocks the repository, so none of them can show that the folder claim
// actually leaves the index.
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
const h = vi.hoisted(() => ({ revokeToken: vi.fn() }));
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

import {
  DataLakeModel,
  OrgGoogleDriveConnection,
  orgGoogleDriveConnectionRepository,
  dataLakeRepository,
  dataLakeBatchRepository,
  dataLakeAccessGrantRepository,
  fabFileRepository,
  fabFileChunkRepository,
} from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { releaseDriveConnectionForLake } from '@server/integrations/google/drive/common';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND hooks.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * End-to-end guard for the lake-purge Drive teardown, driving the REAL cleanupDeletedDataLake and
 * the REAL connection repository against createMongoServer.
 *
 * The failure this pins is not "a function was not called": it is a row surviving its lake and
 * holding the GLOBALLY UNIQUE driveFolderId index, which makes that Drive folder unconnectable by
 * any org, forever, with no product surface able to reach the row (the disconnect route resolves the
 * connection through its lake). Only a real index can show the claim is genuinely released, so these
 * tests re-claim the folder afterwards rather than asserting on a mock.
 */
let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  // The unique driveFolderId index is the whole subject here; build it before any test runs.
  await OrgGoogleDriveConnection.ensureIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  await OrgGoogleDriveConnection.deleteMany({}, { hardDelete: true });
  await DataLakeModel.deleteMany({});
  vi.clearAllMocks();
});

// A real ObjectId: the teardown looks the connecting user up to decide whether the credential is
// theirs personally (see releaseDriveConnection), and User._id is an ObjectId path.
const OWNER = '5f9d88b8c1d2a30017a1c333';
const ORG = '5f9d88b8c1d2a30017a1b111';
const OTHER_ORG = '5f9d88b8c1d2a30017a1b222';

const seedLake = async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return DataLakeModel.create({
    name: 'Drive Lake',
    slug: `drive-lake-${suffix}`,
    fileTagPrefix: `drive-${suffix}:`,
    datalakeTag: `datalake:drive-lake-${suffix}`,
    createdByUserId: OWNER,
    organizationId: ORG,
    status: 'deleted',
  });
};

const seedConnection = (lakeId: string, driveFolderId: string, overrides: Record<string, unknown> = {}) =>
  OrgGoogleDriveConnection.create({
    organizationId: ORG,
    authMode: 'oauth',
    driveFolderId,
    folderName: 'Team Drive Folder',
    targetDataLakeId: lakeId,
    oauthRefreshToken: 'enc(org-refresh)',
    connectedBy: OWNER,
    ...overrides,
  });

/** Can any org connect this Drive folder to a lake now? Returns the duplicate-key error if not. */
const tryClaimFolder = async (driveFolderId: string): Promise<Error | null> => {
  try {
    const row = await OrgGoogleDriveConnection.create({
      organizationId: OTHER_ORG,
      authMode: 'oauth',
      driveFolderId,
      targetDataLakeId: `some-other-lake-${Date.now()}`,
      connectedBy: '5f9d88b8c1d2a30017a1c444',
    });
    await OrgGoogleDriveConnection.deleteOne({ _id: row._id }, { hardDelete: true });
    return null;
  } catch (e) {
    return e as Error;
  }
};

const purge = (lakeId: string) =>
  dataLakeService.cleanupDeletedDataLake({ userId: OWNER, isAdmin: false }, lakeId, {
    db: {
      dataLakes: dataLakeRepository,
      dataLakeAccessGrants: dataLakeAccessGrantRepository,
      batches: dataLakeBatchRepository,
      fabFiles: fabFileRepository,
      fabFileChunks: fabFileChunkRepository,
    },
    // The same wiring the queue consumer uses (dataLakeCleanup.ts).
    releaseDriveConnection: async ({ dataLakeId }) => {
      await releaseDriveConnectionForLake(dataLakeId);
    },
  });

describe('data lake purge Drive teardown (real repos + Mongo)', () => {
  it('frees the folder claim, so the folder is connectable again by another org', async () => {
    const lake = await seedLake();
    const folderId = `folder${Date.now()}`;
    const conn = await seedConnection(lake.id, folderId);

    // The claim is real before the purge: a second row for the folder is rejected by the index.
    expect((await tryClaimFolder(folderId))?.message).toMatch(/E11000/);

    await purge(lake.id);

    expect(await DataLakeModel.countDocuments({ _id: lake._id })).toBe(0);
    // Hard-deleted, not soft: a soft-deleted row keeps the unique index populated and blocks
    // re-claim exactly like a live one, which is the state the bug produced.
    expect(await OrgGoogleDriveConnection.countDocuments({ _id: conn._id })).toBe(0);
    expect(await orgGoogleDriveConnectionRepository.findByDataLakeIdAny(lake.id)).toBeFalsy();
    expect(await tryClaimFolder(folderId)).toBeNull();
  });

  it('releases a DISABLED connection too, which still holds the claim', async () => {
    // findByDataLakeId's enabled-only view cannot see this row, so resolving through it would leave
    // the folder claimed by a connection nothing can reach.
    const lake = await seedLake();
    const folderId = `disabled${Date.now()}`;
    await seedConnection(lake.id, folderId, { enabled: false });

    await purge(lake.id);

    expect(await tryClaimFolder(folderId)).toBeNull();
  });

  it('takes the credential down with the lake rather than leaving it in a stranded row', async () => {
    const lake = await seedLake();
    // A credential the connecting user no longer holds: this row is its last live handle, so the
    // teardown revokes the grant instead of just dropping the row.
    await seedConnection(lake.id, `cred${Date.now()}`);

    await purge(lake.id);

    expect(h.revokeToken).toHaveBeenCalledWith('org-refresh');
    expect(await OrgGoogleDriveConnection.countDocuments({}, { includeDeleted: true })).toBe(0);
  });

  it('purges a lake with no Drive connection without inventing one', async () => {
    const lake = await seedLake();

    await expect(purge(lake.id)).resolves.toBeUndefined();

    expect(await DataLakeModel.countDocuments({ _id: lake._id })).toBe(0);
    expect(h.revokeToken).not.toHaveBeenCalled();
  });

  it('leaves ANOTHER lake connection untouched', async () => {
    // The teardown resolves globally and without an org filter; the bound that keeps that safe is
    // targetDataLakeId, so a second lake's claim must survive the first lake's purge.
    const lake = await seedLake();
    const otherLake = await seedLake();
    const keptFolderId = `kept${Date.now()}`;
    await seedConnection(lake.id, `purged${Date.now()}`);
    await seedConnection(otherLake.id, keptFolderId);

    await purge(lake.id);

    const kept = await orgGoogleDriveConnectionRepository.findByDataLakeIdAny(otherLake.id);
    expect(kept?.driveFolderId).toBe(keptFolderId);
    expect((await tryClaimFolder(keptFolderId))?.message).toMatch(/E11000/);
  });
});
