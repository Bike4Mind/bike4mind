import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';

// Only the app-layer edges are mocked (crypto is unreachable from packages/database and unused by
// this seam anyway); the repository, model and unique index are REAL, which is the point: a mocked
// repository could not show that a re-enable resolves a row the enabled-only finder cannot see.
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

import { DataLakeModel, OrgGoogleDriveConnection, orgGoogleDriveConnectionRepository } from '@bike4mind/database';
import { disableDriveConnectionForLake, enableDriveConnectionForLake } from './common';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND hooks.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * The lake-lifecycle Drive guard's disable/enable side: archive/delete flips `enabled: false` so
 * the hourly poll stops enqueueing the connection, and unarchive/restore flips it back - WITHOUT
 * revoking at Google or touching the row otherwise, unlike releaseDriveConnectionForLake's hard
 * teardown (covered separately in dataLakePurgeDriveConnection.e2e.test.ts).
 */
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
  await OrgGoogleDriveConnection.deleteMany({}, { hardDelete: true });
  await DataLakeModel.deleteMany({});
  vi.clearAllMocks();
});

const OWNER = '5f9d88b8c1d2a30017a1c333';
const ORG = '5f9d88b8c1d2a30017a1b111';

const seedLake = async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return DataLakeModel.create({
    name: 'Drive Lake',
    slug: `drive-lake-${suffix}`,
    fileTagPrefix: `drive-${suffix}:`,
    datalakeTag: `datalake:drive-lake-${suffix}`,
    createdByUserId: OWNER,
    organizationId: ORG,
    status: 'active',
  });
};

const seedConnection = (lakeId: string, overrides: Record<string, unknown> = {}) =>
  OrgGoogleDriveConnection.create({
    organizationId: ORG,
    authMode: 'oauth',
    driveFolderId: `folder-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    folderName: 'Team Drive Folder',
    targetDataLakeId: lakeId,
    connectedBy: OWNER,
    oauthRefreshToken: 'enc(org-refresh)',
    ...overrides,
  });

describe('disableDriveConnectionForLake / enableDriveConnectionForLake (real repo + Mongo)', () => {
  it('disables an enabled connection without deleting the row or touching Google', async () => {
    const lake = await seedLake();
    const conn = await seedConnection(lake.id, { enabled: true });

    const result = await disableDriveConnectionForLake(lake.id);

    expect(result).toBe(true);
    const updated = await OrgGoogleDriveConnection.findById(conn.id);
    expect(updated?.enabled).toBe(false);
    expect(h.revokeToken).not.toHaveBeenCalled();
  });

  it('re-enables a disabled connection, resolving it despite the enabled-only finder', async () => {
    const lake = await seedLake();
    await seedConnection(lake.id, { enabled: false });
    // Sanity: the enabled-only finder genuinely cannot see this row - proves enable must go
    // through findByDataLakeIdAny, not findByDataLakeId.
    expect(await orgGoogleDriveConnectionRepository.findByDataLakeId(lake.id, ORG)).toBeFalsy();

    const result = await enableDriveConnectionForLake(lake.id);

    expect(result).toBe(true);
    expect(await orgGoogleDriveConnectionRepository.findByDataLakeId(lake.id, ORG)).toMatchObject({
      enabled: true,
    });
  });

  it('is a no-op returning false when the lake has no Drive connection', async () => {
    const lake = await seedLake();

    await expect(disableDriveConnectionForLake(lake.id)).resolves.toBe(false);
    await expect(enableDriveConnectionForLake(lake.id)).resolves.toBe(false);
  });

  it('leaves ANOTHER lake connection untouched', async () => {
    const lake = await seedLake();
    const otherLake = await seedLake();
    await seedConnection(lake.id, { enabled: true });
    const otherConn = await seedConnection(otherLake.id, { enabled: true });

    await disableDriveConnectionForLake(lake.id);

    const untouched = await OrgGoogleDriveConnection.findById(otherConn.id);
    expect(untouched?.enabled).toBe(true);
  });
});
