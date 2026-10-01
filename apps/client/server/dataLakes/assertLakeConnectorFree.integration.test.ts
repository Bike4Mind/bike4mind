import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { OrgGitHubLakeConnection, OrgGoogleDriveConnection } from '@bike4mind/database';
import { ConflictError } from '@server/utils/errors';
import { assertLakeConnectorFree } from './assertLakeConnectorFree';

/**
 * The CROSS-COLLECTION claim the unit suite (mocked repos) cannot make: a real GitHub lake
 * connection row, found through the real OrgGitHubLakeConnection repository, actually blocks a
 * Drive-side assertLakeConnectorFree call against a real mongod. The unit test proves the wiring
 * against stubs; this proves the query and the index/document shape are real.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  await OrgGitHubLakeConnection.ensureIndexes();
  await OrgGoogleDriveConnection.ensureIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  await OrgGitHubLakeConnection.deleteMany({});
  await OrgGoogleDriveConnection.deleteMany({});
});

const ORG = '5f9d88b8c1d2a30017a1b111';
const LAKE_ID = '5f9d88b8c1d2a30017a1c222';
const USER = '5f9d88b8c1d2a30017a1c333';

describe('assertLakeConnectorFree (real mongod, cross-collection)', () => {
  it('refuses a Drive-side claim when a real GitHub lake connection row already feeds the lake', async () => {
    await OrgGitHubLakeConnection.create({
      organizationId: ORG,
      targetDataLakeId: LAKE_ID,
      installationId: 42,
      accountLogin: 'acme',
      repositoryId: 100,
      repositoryFullName: 'acme/one',
      connectedBy: USER,
      connectedAt: new Date(),
    });

    await expect(assertLakeConnectorFree(LAKE_ID, { except: 'googleDrive' })).rejects.toThrow(ConflictError);
    await expect(assertLakeConnectorFree(LAKE_ID, { except: 'googleDrive' })).rejects.toThrow(
      /already connected to a GitHub repository/i
    );
  });

  it('resolves when no connector row exists for the lake', async () => {
    await expect(assertLakeConnectorFree(LAKE_ID, { except: 'googleDrive' })).resolves.toBeUndefined();
  });
});
