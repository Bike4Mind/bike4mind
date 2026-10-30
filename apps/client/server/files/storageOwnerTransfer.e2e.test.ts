import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
// createMongoReplSet is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { StorageLimitError } from '@bike4mind/common';
import {
  DataLakeModel,
  dataLakeRepository,
  FabFile,
  fabFileRepository,
  Organization,
  User,
  withTransaction,
} from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { storageOwnerTransferDb } from '@bike4mind/server-utils/files/storageOwnerTransferDb';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * A file's billed bytes follow its lake membership after create: adding it to an org lake moves them
 * onto the org, removing it from every org lake moves them back to the uploader. Drives the REAL
 * membership doors (built dist - run `pnpm --filter @bike4mind/services build` first) against a
 * replica set, inside a transaction like the routes.
 */

const UPLOADER_ID = new mongoose.Types.ObjectId();
const ACME_ID = new mongoose.Types.ObjectId();
const GLOBEX_ID = new mongoose.Types.ObjectId();
const FILE_BYTES = 600_000;
const BASELINE = 1_000_000;
// storageLimit is in MB.
const ROOMY_LIMIT_MB = 100;
const actor = { userId: 'platform-admin', isAdmin: true };

let replSet: Awaited<ReturnType<typeof createMongoReplSet>> | undefined;

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
  await Promise.all([
    FabFile.collection.deleteMany({}),
    User.collection.deleteMany({}),
    Organization.collection.deleteMany({}),
    DataLakeModel.collection.deleteMany({}),
  ]);
});

const seedOwners = async ({ acmeLimitMb = ROOMY_LIMIT_MB }: { acmeLimitMb?: number } = {}) => {
  await User.collection.insertOne({
    _id: UPLOADER_ID,
    username: 'uploader',
    email: 'uploader@example.com',
    currentStorageSize: BASELINE,
    storageLimit: ROOMY_LIMIT_MB,
  });
  await Organization.collection.insertMany([
    { _id: ACME_ID, name: 'Acme', currentStorageSize: BASELINE, storageLimit: acmeLimitMb },
    { _id: GLOBEX_ID, name: 'Globex', currentStorageSize: BASELINE, storageLimit: ROOMY_LIMIT_MB },
  ]);
};

const seedLake = (slug: string, organizationId?: mongoose.Types.ObjectId) =>
  dataLakeRepository.create({
    name: slug,
    slug,
    fileTagPrefix: `${slug}:`,
    datalakeTag: `datalake:${slug}`,
    createdByUserId: 'lake-creator',
    isPublic: false,
    status: 'active',
    ...(organizationId && { organizationId: organizationId.toString() }),
  } as never);

const seedFile = async (tags: string[], organizationId?: mongoose.Types.ObjectId) => {
  const { insertedId } = await FabFile.collection.insertOne({
    userId: UPLOADER_ID.toString(),
    fileName: 'report.pdf',
    mimeType: 'application/pdf',
    type: 'FILE',
    fileSize: FILE_BYTES,
    status: 'complete',
    storageChargedAt: new Date(),
    createdAt: new Date(),
    tags: tags.map(name => ({ name, strength: 1 })),
    ...(organizationId && { organizationId: organizationId.toString() }),
  });
  return insertedId.toString();
};

const storedOwner = async (fabFileId: string) =>
  (await FabFile.collection.findOne({ _id: new mongoose.Types.ObjectId(fabFileId) }))?.organizationId;
const userBytes = async () => (await User.collection.findOne({ _id: UPLOADER_ID }))?.currentStorageSize;
const orgBytes = async (id: mongoose.Types.ObjectId) =>
  (await Organization.collection.findOne({ _id: id }))?.currentStorageSize;

const add = (lake: Awaited<ReturnType<typeof seedLake>>, fabFileId: string) =>
  withTransaction(() => dataLakeService.addFileToLake(actor, lake, fabFileId, { db: storageOwnerTransferDb }));
const remove = (lake: Awaited<ReturnType<typeof seedLake>>, fabFileId: string) =>
  withTransaction(() => dataLakeService.removeFileFromLake(actor, lake, fabFileId, { db: storageOwnerTransferDb }));

describe('storage owner follows lake membership', () => {
  it("moves a personal file's bytes onto the org when it joins an org lake", async () => {
    await seedOwners();
    const acme = await seedLake('acme', ACME_ID);
    const fileId = await seedFile([]);

    await add(acme, fileId);

    expect(await storedOwner(fileId)).toBe(ACME_ID.toString());
    expect(await userBytes()).toBe(BASELINE - FILE_BYTES);
    expect(await orgBytes(ACME_ID)).toBe(BASELINE + FILE_BYTES);
  });

  it('moves the bytes back to the uploader when the file leaves its only org lake', async () => {
    await seedOwners();
    const acme = await seedLake('acme', ACME_ID);
    const fileId = await seedFile(['datalake:acme'], ACME_ID);

    await remove(acme, fileId);

    expect(await storedOwner(fileId)).toBeUndefined();
    expect(await orgBytes(ACME_ID)).toBe(BASELINE - FILE_BYTES);
    expect(await userBytes()).toBe(BASELINE + FILE_BYTES);
  });

  it('hands the file to the remaining org lake when it leaves the owning one', async () => {
    await seedOwners();
    const acme = await seedLake('acme', ACME_ID);
    await seedLake('globex', GLOBEX_ID);
    const fileId = await seedFile(['datalake:acme', 'datalake:globex'], ACME_ID);

    await remove(acme, fileId);

    expect(await storedOwner(fileId)).toBe(GLOBEX_ID.toString());
    expect(await orgBytes(ACME_ID)).toBe(BASELINE - FILE_BYTES);
    expect(await orgBytes(GLOBEX_ID)).toBe(BASELINE + FILE_BYTES);
    expect(await userBytes()).toBe(BASELINE);
  });

  it('leaves owner and counters alone when a personal lake is added', async () => {
    await seedOwners();
    const mine = await seedLake('mine');
    const fileId = await seedFile(['datalake:acme'], ACME_ID);
    await seedLake('acme', ACME_ID);

    await add(mine, fileId);

    expect(await storedOwner(fileId)).toBe(ACME_ID.toString());
    expect(await orgBytes(ACME_ID)).toBe(BASELINE);
    expect(await userBytes()).toBe(BASELINE);
  });

  it("refuses a join that would overflow the org's pool, writing nothing", async () => {
    // A 1 MB pool already holding BASELINE bytes has no room for FILE_BYTES more.
    await seedOwners({ acmeLimitMb: 1 });
    const acme = await seedLake('acme', ACME_ID);
    const fileId = await seedFile([]);

    await expect(add(acme, fileId)).rejects.toBeInstanceOf(StorageLimitError);

    const file = await FabFile.collection.findOne({ _id: new mongoose.Types.ObjectId(fileId) });
    expect(file?.tags).toEqual([]);
    expect(file?.organizationId).toBeUndefined();
    expect(await userBytes()).toBe(BASELINE);
    expect(await orgBytes(ACME_ID)).toBe(BASELINE);
  });

  it('moves a legacy row that stores no status when it leaves its only org lake', async () => {
    await seedOwners();
    const acme = await seedLake('acme', ACME_ID);
    const fileId = await seedFile(['datalake:acme'], ACME_ID);
    // Pre-status rows are live in prod: the hydrated read fills in the schema default, but the
    // stored document has no such field, so the restamp's compare-and-set must still match it.
    await FabFile.collection.updateOne({ _id: new mongoose.Types.ObjectId(fileId) }, { $unset: { status: '' } });

    await remove(acme, fileId);

    expect(await storedOwner(fileId)).toBeUndefined();
    expect(await orgBytes(ACME_ID)).toBe(BASELINE - FILE_BYTES);
    expect(await userBytes()).toBe(BASELINE + FILE_BYTES);
  });

  it('lets a removal through even when the uploader is over quota', async () => {
    await seedOwners();
    await User.collection.updateOne({ _id: UPLOADER_ID }, { $set: { storageLimit: 0 } });
    const acme = await seedLake('acme', ACME_ID);
    const fileId = await seedFile(['datalake:acme'], ACME_ID);

    await remove(acme, fileId);

    expect(await storedOwner(fileId)).toBeUndefined();
    expect(await userBytes()).toBe(BASELINE + FILE_BYTES);
  });
});

describe('setOwnerOrganizationIfUnchanged', () => {
  it('refuses to restamp a row whose charged bytes moved since it was read', async () => {
    const fileId = await seedFile([]);
    const read = await fabFileRepository.findById(fileId);
    await FabFile.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(fileId) },
      { $set: { fileSize: FILE_BYTES * 2 } }
    );

    expect(await fabFileRepository.setOwnerOrganizationIfUnchanged(fileId, read!, ACME_ID.toString())).toBe(false);
    expect(await storedOwner(fileId)).toBeUndefined();
  });

  it('restamps a legacy row that stores no status', async () => {
    const fileId = await seedFile([]);
    await FabFile.collection.updateOne({ _id: new mongoose.Types.ObjectId(fileId) }, { $unset: { status: '' } });
    // The hydrated read reports the schema default 'pending' for this row.
    const read = await fabFileRepository.findById(fileId);

    expect(await fabFileRepository.setOwnerOrganizationIfUnchanged(fileId, read!, ACME_ID.toString())).toBe(true);
    expect(await storedOwner(fileId)).toBe(ACME_ID.toString());
  });

  it('restamps, then unstamps, an unchanged row', async () => {
    const fileId = await seedFile([]);
    const read = await fabFileRepository.findById(fileId);

    expect(await fabFileRepository.setOwnerOrganizationIfUnchanged(fileId, read!, ACME_ID.toString())).toBe(true);
    expect(await storedOwner(fileId)).toBe(ACME_ID.toString());

    const stamped = await fabFileRepository.findById(fileId);
    expect(await fabFileRepository.setOwnerOrganizationIfUnchanged(fileId, stamped!, undefined)).toBe(true);
    expect(await storedOwner(fileId)).toBeUndefined();
  });
});
