import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';
import { User, DataLakeModel, OrgGoogleDriveConnection, orgGoogleDriveConnectionRepository } from '@bike4mind/database';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND hooks.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * End-to-end guard for the drive-sync enqueue-failure path, driving the REAL handler through the
 * REAL repositories and the REAL globally-unique driveFolderId index against createMongoServer.
 *
 * drive-sync.test.ts asserts the handler CALLS release(); only this file proves that call actually
 * frees the claim. The claim is a unique-index entry, and a soft-deleted or disabled row still
 * populates it - so "release was called" and "the folder is re-claimable" are genuinely different
 * facts, and the acceptance criterion is the second one. Mocks stop at the Drive/auth/crypto
 * boundary; Mongo, the model, its indexes and release() are all real.
 */

const h = vi.hoisted(() => ({
  // Flips the `sst` Resource mock between a resolvable queue url and the self-host shape where the
  // queue is absent from the manifest and the PROPERTY READ itself throws. That read sits inside
  // the handler's try block; hoisting the url out of it would strand the claim again, which is the
  // regression the 'unregistered' case below pins.
  resourceUnregistered: { value: false },
  sendToQueue: vi.fn(),
  verifyOrgAccess: vi.fn(),
  getValidUserDriveAccessToken: vi.fn(),
  createDriveClient: vi.fn(),
  getFolderAccess: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@server/utils/orgAccess', () => ({ verifyOrgAccess: h.verifyOrgAccess }));
vi.mock('@server/integrations/google/drive/common', () => ({
  getValidUserDriveAccessToken: h.getValidUserDriveAccessToken,
}));
// Keep isValidDriveFolderId real; mock only the Drive network calls.
vi.mock('@server/integrations/google/drive/driveClient', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/integrations/google/drive/driveClient')>();
  return { ...actual, createDriveClient: h.createDriveClient, getFolderAccess: h.getFolderAccess };
});
vi.mock('@server/security/tokenEncryption', () => ({ decryptToken: () => 'plaintext-refresh-token' }));
vi.mock('@server/security/secretEncryption', () => ({ isEncrypted: () => true }));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));
vi.mock('sst', () => ({
  Resource: {
    get driveLakeIngestQueue() {
      if (h.resourceUnregistered.value) {
        throw new Error('Resource.driveLakeIngestQueue is not registered in the self-host manifest.');
      }
      return { url: 'https://sqs.us-east-2.amazonaws.com/000000000000/driveLakeIngestQueue' };
    },
  },
}));

import handler from '../drive-sync';

const FOLDER_ID = 'Folder_ClaimRelease-1';
const ORG_A = 'org-a';
const ORG_B = 'org-b';

let mongoServer: MongoMemoryServer;

const makeRes = () => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { res: { json, status } as never, json, status };
};
const makeReq = (body: Record<string, unknown>, userId: string) =>
  ({ method: 'POST', body, user: { id: userId, isAdmin: false }, logger: { error: vi.fn() } }) as never;
const run = (req: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

/** A real user carrying the encrypted Drive credential captureOrgCredential copies. */
async function seedUser() {
  const user = await User.create({
    username: `u-drive-claim-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: 'Drive Claim Tester',
    googleDrive: {
      refreshToken: 'enc:refresh-token',
      accessToken: 'enc:access-token',
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  return user.id as string;
}

async function seedLake(userId: string, organizationId: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const lake = await DataLakeModel.create({
    name: `drive-claim-${suffix}`,
    slug: `drive-claim-${suffix}`,
    fileTagPrefix: `dc-${suffix}:`,
    datalakeTag: `datalake:dc-${suffix}`,
    createdByUserId: userId,
    organizationId,
    status: 'active',
  });
  return lake.id as string;
}

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  // Build the unique indexes, or the global driveFolderId claim this file is about does not exist.
  await OrgGoogleDriveConnection.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

afterEach(async () => {
  h.resourceUnregistered.value = false;
  h.sendToQueue.mockReset();
  // Per-collection deletes, NOT dropDatabase: dropping the database also drops the unique
  // driveFolderId index, and Mongoose only autoIndexes once per model per connection - every test
  // after the first would then run without the index this whole file is about, and pass either way.
  await Promise.all([
    OrgGoogleDriveConnection.deleteMany({}, { hardDelete: true }),
    DataLakeModel.deleteMany({}, { hardDelete: true }),
    User.deleteMany({}, { hardDelete: true }),
  ]);
});

beforeEach(() => {
  h.verifyOrgAccess.mockResolvedValue(undefined);
  h.getValidUserDriveAccessToken.mockResolvedValue('user-access-token');
  h.createDriveClient.mockReturnValue({});
  h.getFolderAccess.mockResolvedValue({ exists: true, isFolder: true, canRead: true });
  h.sendToQueue.mockResolvedValue(undefined);
});

describe('POST /api/data-lakes/drive-sync - the global Drive folder claim survives no enqueue failure', () => {
  it('has the global driveFolderId unique index the rest of this file depends on', async () => {
    // Pins this file's own premise: without the unique index every assertion below still passes
    // while proving nothing about the claim.
    const indexes = await OrgGoogleDriveConnection.collection.indexes();
    expect(indexes.some(i => i.name === 'org_gdrive_conn_folder_id' && i.unique === true)).toBe(true);
  });

  it('leaves the folder re-claimable by ANOTHER org after the enqueue fails', async () => {
    const userId = await seedUser();
    const lakeA = await seedLake(userId, ORG_A);
    h.sendToQueue.mockRejectedValue(new Error('SQS unavailable: connect ETIMEDOUT'));

    const { res, status } = makeRes();
    await expect(run(makeReq({ dataLakeId: lakeA, driveFolderId: FOLDER_ID }, userId), res)).rejects.toThrow(
      /could not queue/i
    );
    expect(status).not.toHaveBeenCalledWith(202);

    // The row is GONE, not merely disabled - a disabled row keeps the unique index populated.
    expect(await orgGoogleDriveConnectionRepository.findByDriveFolderId(FOLDER_ID)).toBeFalsy();
    expect(await OrgGoogleDriveConnection.countDocuments({ driveFolderId: FOLDER_ID })).toBe(0);

    // The acceptance criterion: a different org can now claim the same folder, with no manual DB
    // work. Against a stranded row this create would throw E11000 on the global unique index.
    const lakeB = await seedLake(userId, ORG_B);
    const reclaimed = await orgGoogleDriveConnectionRepository.create({
      organizationId: ORG_B,
      authMode: 'oauth',
      driveFolderId: FOLDER_ID,
      targetDataLakeId: lakeB,
      oauthRefreshToken: 'enc:other',
      connectedBy: userId,
      enabled: true,
      status: 'connected',
    } as never);
    expect(reclaimed.driveFolderId).toBe(FOLDER_ID);
  });

  it('leaves the folder re-claimable when the ingest queue is absent from the manifest', async () => {
    // The self-host shape: `Resource.driveLakeIngestQueue` throws on PROPERTY ACCESS, before
    // sendToQueue is ever reached. Pins that read inside the try - hoisting the url above it would
    // strand the claim while every sendToQueue-rejects test still passed.
    const userId = await seedUser();
    const lakeA = await seedLake(userId, ORG_A);
    h.resourceUnregistered.value = true;

    const { res, status } = makeRes();
    await expect(run(makeReq({ dataLakeId: lakeA, driveFolderId: FOLDER_ID }, userId), res)).rejects.toThrow(
      /could not queue/i
    );
    expect(status).not.toHaveBeenCalledWith(202);
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(await OrgGoogleDriveConnection.countDocuments({ driveFolderId: FOLDER_ID })).toBe(0);

    // Same folder, same org, retried after the queue is registered: succeeds, so the failure left
    // nothing behind that a retry has to work around.
    h.resourceUnregistered.value = false;
    const retry = makeRes();
    await run(makeReq({ dataLakeId: lakeA, driveFolderId: FOLDER_ID }, userId), retry.res);
    expect(retry.status).toHaveBeenCalledWith(202);
    expect(await orgGoogleDriveConnectionRepository.findByDriveFolderId(FOLDER_ID)).not.toBeNull();
  });

  it('keeps a pre-existing connection when a RE-SYNC enqueue fails', async () => {
    // The reuse branch did not take the claim. Deleting a working connection over a missed re-sync
    // would be worse than the missed ingest, and the resync poll re-enqueues it anyway.
    const userId = await seedUser();
    const lakeA = await seedLake(userId, ORG_A);

    const first = makeRes();
    await run(makeReq({ dataLakeId: lakeA, driveFolderId: FOLDER_ID }, userId), first.res);
    expect(first.status).toHaveBeenCalledWith(202);
    const established = await orgGoogleDriveConnectionRepository.findByDriveFolderId(FOLDER_ID);
    expect(established).not.toBeNull();

    h.sendToQueue.mockRejectedValue(new Error('SQS unavailable: connect ETIMEDOUT'));
    const { res } = makeRes();
    await expect(run(makeReq({ dataLakeId: lakeA, driveFolderId: FOLDER_ID }, userId), res)).rejects.toThrow(
      /could not queue/i
    );

    const survivor = await orgGoogleDriveConnectionRepository.findByDriveFolderId(FOLDER_ID);
    expect(survivor?.id).toBe(established?.id);
    expect(survivor?.status).toBe('connected');
  });

  it('does not report Connected for a folder whose ingest was never accepted', async () => {
    // The UI reads the org's connections; a stranded row showed Connected for a folder that would
    // never ingest. After a failed enqueue the org has no connection at all.
    const userId = await seedUser();
    const lakeA = await seedLake(userId, ORG_A);
    h.sendToQueue.mockRejectedValue(new Error('AccessDenied: not authorized to perform sqs:SendMessage'));

    const { res } = makeRes();
    await expect(run(makeReq({ dataLakeId: lakeA, driveFolderId: FOLDER_ID }, userId), res)).rejects.toThrow(
      /could not queue/i
    );

    expect(await orgGoogleDriveConnectionRepository.findByOrganizationIdAny(ORG_A)).toEqual([]);
  });
});
