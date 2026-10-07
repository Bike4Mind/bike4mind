import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose, { Types } from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import {
  LakeConnectorClaim,
  OrgGitHubLakeConnection,
  OrgGoogleDriveConnection,
  orgGitHubLakeConnectionRepository,
  orgGoogleDriveConnectionRepository,
} from '@bike4mind/database';
import { ConflictError } from '@server/utils/errors';
import { withConnectionId, withLakeConnectorClaim } from './assertLakeConnectorFree';

/**
 * The race the per-collection unique indexes cannot stop: a Drive connect and a GitHub connect on
 * the same lake write to different collections, so only the lake claim makes one of them lose.
 * The create callbacks mirror the ones in drive-sync.ts and githubLakeConnection.ts.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const ORG = '5f9d88b8c1d2a30017a1b111';
const USER = '5f9d88b8c1d2a30017a1c333';
const RACE_ROUNDS = 25;
// Holds each create open long enough that both connects pass the legacy-row check before either row lands.
const CREATE_DELAY_MS = 20;

let mongoServer: MongoMemoryServer;
let seq = 0;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([
    OrgGitHubLakeConnection.ensureIndexes(),
    OrgGoogleDriveConnection.ensureIndexes(),
    LakeConnectorClaim.ensureIndexes(),
  ]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  await Promise.all([
    OrgGitHubLakeConnection.deleteMany({}),
    OrgGoogleDriveConnection.deleteMany({}),
    LakeConnectorClaim.deleteMany({}),
  ]);
});

const pause = () => new Promise(resolve => setTimeout(resolve, CREATE_DELAY_MS));

function connectGitHub(lakeId: string) {
  const n = ++seq;
  return withLakeConnectorClaim(lakeId, 'github', async claimedId => {
    await pause();
    return orgGitHubLakeConnectionRepository.create(
      withConnectionId(claimedId, {
        organizationId: ORG,
        targetDataLakeId: lakeId,
        installationId: 42,
        accountLogin: 'acme',
        repositoryId: 1000 + n,
        repositoryFullName: `acme/repo-${n}`,
        connectedBy: USER,
        connectedAt: new Date(),
      })
    );
  });
}

function connectDrive(lakeId: string) {
  const n = ++seq;
  return withLakeConnectorClaim(lakeId, 'googleDrive', async claimedId => {
    await pause();
    return orgGoogleDriveConnectionRepository.create(
      withConnectionId(claimedId, {
        organizationId: ORG,
        authMode: 'oauth' as const,
        driveFolderId: `folder-${n}`,
        folderName: `Folder ${n}`,
        targetDataLakeId: lakeId,
        connectedBy: USER,
        enabled: true,
        status: 'connected' as const,
        connectedAt: new Date(),
      })
    );
  });
}

async function rowsForLake(lakeId: string) {
  const [github, drive] = await Promise.all([
    OrgGitHubLakeConnection.countDocuments({ targetDataLakeId: lakeId }),
    OrgGoogleDriveConnection.countDocuments({ targetDataLakeId: lakeId }),
  ]);
  return github + drive;
}

describe('withLakeConnectorClaim (real mongod, concurrent connect)', () => {
  it(`lets exactly one of a concurrent Drive and GitHub connect bind the lake, ${RACE_ROUNDS} rounds`, async () => {
    for (let round = 0; round < RACE_ROUNDS; round++) {
      const lakeId = new Types.ObjectId().toString();
      const [drive, github] = await Promise.allSettled([connectDrive(lakeId), connectGitHub(lakeId)]);

      const fulfilled = [drive, github].filter(r => r.status === 'fulfilled');
      const rejected = [drive, github].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(fulfilled, `round ${round}`).toHaveLength(1);
      expect(rejected, `round ${round}`).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ConflictError);
      expect(rejected[0].reason.statusCode).toBe(409);

      expect(await rowsForLake(lakeId)).toBe(1);
      const claims = await LakeConnectorClaim.find({ lakeId }).lean();
      expect(claims).toHaveLength(1);
      const winner = (fulfilled[0] as PromiseFulfilledResult<{ id: string }>).value;
      expect(String(claims[0].connectionId)).toBe(winner.id);
    }
  });

  it('frees the lake when the bound connector is released, so the other kind can connect', async () => {
    const lakeId = new Types.ObjectId().toString();
    const github = await connectGitHub(lakeId);

    await expect(connectDrive(lakeId)).rejects.toThrow(/already connected to a GitHub repository/i);

    expect(await orgGitHubLakeConnectionRepository.release(github.id, ORG)).toBe(true);
    expect(await LakeConnectorClaim.countDocuments({ lakeId })).toBe(0);

    const drive = await connectDrive(lakeId);
    const claim = await LakeConnectorClaim.findOne({ lakeId }).lean();
    expect(claim?.kind).toBe('googleDrive');
    expect(String(claim?.connectionId)).toBe(drive.id);
  });

  it('refuses a connect on a legacy lake that has a connector row but no claim, and leaves no claim behind', async () => {
    const lakeId = new Types.ObjectId().toString();
    await OrgGitHubLakeConnection.create({
      organizationId: ORG,
      targetDataLakeId: lakeId,
      installationId: 42,
      accountLogin: 'acme',
      repositoryId: 99,
      repositoryFullName: 'acme/legacy',
      connectedBy: USER,
      connectedAt: new Date(),
    });
    expect(await LakeConnectorClaim.countDocuments({ lakeId })).toBe(0);

    await expect(connectDrive(lakeId)).rejects.toThrow(/already connected to a GitHub repository/i);

    expect(await OrgGoogleDriveConnection.countDocuments({ targetDataLakeId: lakeId })).toBe(0);
    expect(await LakeConnectorClaim.countDocuments({ lakeId })).toBe(0);
  });
});
