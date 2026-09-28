import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

import {
  DataLakeModel,
  FabFile,
  FabFileChunk,
  fabFileChunkRepository,
  fabFileRepository,
  userRepository,
} from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { KnowledgeType } from '@bike4mind/common';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND hooks.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * End-to-end guard for the CONTENT half of the Drive-disconnect purge: `purgeDataLakeConnectionFiles`
 * against the REAL FabFile/FabFileChunk repositories over `createMongoServer`.
 *
 * `dataLakePurgeDriveConnection.e2e.test.ts` (alongside this file) already pins the connection-row
 * teardown (the Google grant + the globally-unique driveFolderId claim). This file pins the OTHER
 * half of the bug the same issue reported: every FabFile a Drive connection ingested surviving its
 * disconnect, with no product surface left able to reach or reprocess them. A fake in-memory
 * `storage` port stands in for S3 - the point here is the Mongo-side sweep and the sibling/manual
 * file boundary, not the object store itself.
 */
let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  await FabFile.deleteMany({}, { hardDelete: true } as Record<string, unknown>);
  await FabFileChunk.deleteMany({});
  await DataLakeModel.deleteMany({});
  vi.clearAllMocks();
});

const OWNER = '5f9d88b8c1d2a30017a1c333';
const CONTRIBUTOR = '5f9d88b8c1d2a30017a1c444';

const seedLake = async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return DataLakeModel.create({
    name: 'Drive Lake',
    slug: `drive-lake-${suffix}`,
    fileTagPrefix: `drive-${suffix}:`,
    datalakeTag: `datalake:drive-lake-${suffix}`,
    createdByUserId: OWNER,
    organizationId: '5f9d88b8c1d2a30017a1b111',
    status: 'active',
  });
};

/** Seeds a lake member, tagged directly the way driveLakeIngest.ts stamps the meta-tag at creation. */
const seedFile = async (opts: {
  datalakeTag: string;
  driveConnectionId?: string;
  userId?: string;
  fileSize?: number;
}) => {
  const doc = await FabFile.create({
    userId: opts.userId ?? OWNER,
    fileName: `file-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    type: KnowledgeType.FILE,
    status: 'complete',
    fileSize: opts.fileSize ?? 100,
    filePath: `files/${new mongoose.Types.ObjectId().toHexString()}`,
    tags: [{ name: opts.datalakeTag, strength: 1 }],
    ...(opts.driveConnectionId ? { driveConnectionId: opts.driveConnectionId } : {}),
  });
  await FabFileChunk.create({ fabFileId: doc.id, text: 'hello world', tokenCount: 2 });
  return doc;
};

/** In-memory stand-in for the object store: records every path it was asked to delete. */
const fakeStorage = () => {
  const deleted: string[] = [];
  return { deleted, storage: { delete: async (path: string) => void deleted.push(path) } };
};

const purgeConnection = (
  lake: { datalakeTag: string; fileTagPrefix: string; createdByUserId: string },
  files: unknown
) =>
  dataLakeService.purgeDataLakeConnectionFiles(
    dataLakeService.lakeMembershipScope(lake),
    files as Parameters<typeof dataLakeService.purgeDataLakeConnectionFiles>[1],
    {
      db: { fabFiles: fabFileRepository, fabFileChunks: fabFileChunkRepository, users: userRepository },
    }
  );

describe('data lake purge Drive teardown - ingested content (real repos + Mongo)', () => {
  it('removes every FabFile and chunk a connection ingested, and their stored objects', async () => {
    const lake = await seedLake();
    const connectionId = new mongoose.Types.ObjectId().toHexString();
    const fileA = await seedFile({ datalakeTag: lake.datalakeTag, driveConnectionId: connectionId });
    const fileB = await seedFile({ datalakeTag: lake.datalakeTag, driveConnectionId: connectionId });

    const files = await fabFileRepository.findByDriveConnectionIdInDataLake(connectionId, lake.datalakeTag);
    expect(files).toHaveLength(2);

    const { storage, deleted } = fakeStorage();
    const result = await purgeConnection(lake, files);

    expect(result.filesPurged).toBe(2);
    expect(await FabFile.countDocuments({ _id: { $in: [fileA.id, fileB.id] } }, { includeDeleted: true })).toBe(0);
    expect(await FabFileChunk.countDocuments({ fabFileId: { $in: [fileA.id, fileB.id] } })).toBe(0);

    // Re-run with storage wired to prove the object-store half separately (purge already
    // hard-deleted the rows above, so this exercises the storage arm against a fresh pair).
    const fileC = await seedFile({ datalakeTag: lake.datalakeTag, driveConnectionId: connectionId });
    const [reloaded] = await fabFileRepository.findByDriveConnectionIdInDataLake(connectionId, lake.datalakeTag);
    await dataLakeService.purgeDataLakeConnectionFiles(dataLakeService.lakeMembershipScope(lake), [reloaded], {
      db: { fabFiles: fabFileRepository, fabFileChunks: fabFileChunkRepository, users: userRepository },
      storage,
    });
    expect(deleted).toEqual([fileC.filePath]);
  });

  it('leaves a sibling Drive connection in the SAME lake untouched', async () => {
    const lake = await seedLake();
    const purgedConnectionId = new mongoose.Types.ObjectId().toHexString();
    const siblingConnectionId = new mongoose.Types.ObjectId().toHexString();
    await seedFile({ datalakeTag: lake.datalakeTag, driveConnectionId: purgedConnectionId });
    const siblingFile = await seedFile({ datalakeTag: lake.datalakeTag, driveConnectionId: siblingConnectionId });

    const files = await fabFileRepository.findByDriveConnectionIdInDataLake(purgedConnectionId, lake.datalakeTag);
    await purgeConnection(lake, files);

    expect(await FabFile.findById(siblingFile.id)).toBeTruthy();
    expect(await FabFileChunk.countDocuments({ fabFileId: siblingFile.id })).toBe(1);
  });

  it('leaves a manually-uploaded file in the same lake untouched', async () => {
    const lake = await seedLake();
    const connectionId = new mongoose.Types.ObjectId().toHexString();
    await seedFile({ datalakeTag: lake.datalakeTag, driveConnectionId: connectionId });
    // No driveConnectionId at all - a file someone attached to the lake by hand.
    const manualFile = await seedFile({ datalakeTag: lake.datalakeTag, userId: CONTRIBUTOR });

    const files = await fabFileRepository.findByDriveConnectionIdInDataLake(connectionId, lake.datalakeTag);
    await purgeConnection(lake, files);

    expect(await FabFile.findById(manualFile.id)).toBeTruthy();
    expect(await FabFileChunk.countDocuments({ fabFileId: manualFile.id })).toBe(1);
  });

  it('is a no-op when the connection ingested no files', async () => {
    const lake = await seedLake();
    const connectionId = new mongoose.Types.ObjectId().toHexString();

    const files = await fabFileRepository.findByDriveConnectionIdInDataLake(connectionId, lake.datalakeTag);
    const result = await purgeConnection(lake, files);

    expect(result).toEqual({ filesPurged: 0, storageObjectsDeleted: 0 });
  });

  it("calls shredDocumentMemory once per deleted file, with that file's own tags and owner", async () => {
    const lake = await seedLake();
    const connectionId = new mongoose.Types.ObjectId().toHexString();
    const fileA = await seedFile({ datalakeTag: lake.datalakeTag, driveConnectionId: connectionId, userId: OWNER });
    const fileB = await seedFile({
      datalakeTag: lake.datalakeTag,
      driveConnectionId: connectionId,
      userId: CONTRIBUTOR,
    });

    const files = await fabFileRepository.findByDriveConnectionIdInDataLake(connectionId, lake.datalakeTag);
    const shredDocumentMemory = vi.fn(async () => {});
    const result = await dataLakeService.purgeDataLakeConnectionFiles(
      dataLakeService.lakeMembershipScope(lake),
      files,
      {
        db: { fabFiles: fabFileRepository, fabFileChunks: fabFileChunkRepository, users: userRepository },
        shredDocumentMemory,
      }
    );

    expect(result.filesPurged).toBe(2);
    expect(shredDocumentMemory).toHaveBeenCalledTimes(2);
    expect(shredDocumentMemory).toHaveBeenCalledWith({
      tagNames: [lake.datalakeTag],
      fabFileId: fileA.id,
      ownerUserId: OWNER,
    });
    expect(shredDocumentMemory).toHaveBeenCalledWith({
      tagNames: [lake.datalakeTag],
      fabFileId: fileB.id,
      ownerUserId: CONTRIBUTOR,
    });
  });

  it('refunds each owner their storage quota for the bytes it actually deleted', async () => {
    const lake = await seedLake();
    const connectionId = new mongoose.Types.ObjectId().toHexString();
    await seedFile({ datalakeTag: lake.datalakeTag, driveConnectionId: connectionId, userId: OWNER, fileSize: 500 });
    await seedFile({
      datalakeTag: lake.datalakeTag,
      driveConnectionId: connectionId,
      userId: CONTRIBUTOR,
      fileSize: 300,
    });

    const increment = vi.spyOn(userRepository, 'incrementCurrentStorage').mockResolvedValue(undefined);
    const files = await fabFileRepository.findByDriveConnectionIdInDataLake(connectionId, lake.datalakeTag);
    await purgeConnection(lake, files);

    expect(increment).toHaveBeenCalledWith(OWNER, -500);
    expect(increment).toHaveBeenCalledWith(CONTRIBUTOR, -300);
  });
});
