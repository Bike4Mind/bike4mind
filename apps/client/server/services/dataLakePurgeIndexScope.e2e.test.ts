import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { KnowledgeType } from '@bike4mind/common';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer } from '../../../../packages/database/src/__test__/createMongoServer';
import {
  FabFile,
  DataLakeModel,
  fabFileRepository,
  fabFileChunkRepository,
  dataLakeRepository,
  dataLakeBatchRepository,
} from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import type { RetrievalIndexPort, RetrievalIndexRemoval } from '@bike4mind/services';

/**
 * End-to-end guard for the data lake purge index-removal contract, driving the REAL
 * cleanupDeletedDataLake service function through the REAL FabFile/DataLake repositories against
 * createMongoServer: seed a lake with a meta-tagged file and a prefix-only member (both owned by
 * the creator) plus a same-prefix stranger's file, purge it, and check what the retrieval-index
 * port was actually told to remove against what really left Mongo. Every unit layer here mocks its
 * neighbor, so only this test proves the ids the port receives are the SAME set the hard-delete
 * destroys - a mock can assert a contract the real membership scope doesn't deliver. Lives in
 * apps/client because it is the only package with both @bike4mind/services and @bike4mind/database
 * as dependencies. Consumes the built dist, so `pnpm turbo:core:build` must be current.
 */

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
}, 30000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
}, 30000);
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

const CREATOR = 'u-lake-creator';
const STRANGER = 'u-stranger';

const makeFile = (overrides: { fileName: string; userId: string; tags: { name: string }[] }) =>
  FabFile.create({
    mimeType: 'text/plain',
    type: KnowledgeType.FILE,
    filePath: overrides.fileName,
    fileSize: 100,
    status: 'complete',
    ...overrides,
  });

async function seedLake() {
  const datalakeTag = `datalake:acme-docs-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const metaTagged = await makeFile({ fileName: 'meta.txt', userId: CREATOR, tags: [{ name: datalakeTag }] });
  const prefixOwned = await makeFile({
    fileName: 'prefix-owned.txt',
    userId: CREATOR,
    tags: [{ name: 'acme:report' }],
  });
  const strangerFile = await makeFile({ fileName: 'stranger.txt', userId: STRANGER, tags: [{ name: 'acme:other' }] });

  const lake = await DataLakeModel.create({
    name: 'Acme Docs',
    slug: `acme-docs-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    fileTagPrefix: 'acme:',
    datalakeTag,
    createdByUserId: CREATOR,
    status: 'deleted',
  });

  for (const f of [metaTagged, prefixOwned, strangerFile]) {
    // createdAt/updatedAt are declared on IFabFileChunkDocument (via IMongoDocument) but populated
    // by the schema's `timestamps: true`; passing placeholders satisfies bulkInsert's real type
    // without a cast.
    await fabFileChunkRepository.bulkInsert([
      {
        text: `chunk for ${f.fileName}`,
        fabFileId: f._id.toString(),
        tokenCount: 5,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
  }

  return { lake, metaTagged, prefixOwned, strangerFile };
}

const fileExists = async (id: string) =>
  (await FabFile.collection.countDocuments({ _id: new mongoose.Types.ObjectId(id) })) === 1;

const runCleanup = (lakeId: string, retrievalIndex: RetrievalIndexPort) =>
  dataLakeService.cleanupDeletedDataLake({ userId: CREATOR, isAdmin: false }, lakeId, {
    db: {
      dataLakes: dataLakeRepository,
      batches: dataLakeBatchRepository,
      fabFiles: fabFileRepository,
      fabFileChunks: fabFileChunkRepository,
    },
    retrievalIndex,
  });

describe('data lake purge index-removal scope (real repos + Mongo)', () => {
  it('tells the index every file it purges, prefix-only members included', async () => {
    const { lake, metaTagged, prefixOwned, strangerFile } = await seedLake();
    let received: RetrievalIndexRemoval | undefined;
    const port: RetrievalIndexPort = {
      async removeForDataLake(input) {
        received = input;
      },
    };

    await runCleanup(lake._id.toString(), port);

    // a) the scope carries every field a meta-tag-only key would lack.
    expect(received?.scope.datalakeTag).toBeTruthy();
    expect(received?.scope.fileTagPrefix).toBeTruthy();
    expect(received?.scope.creatorUserId).toBeTruthy();

    // b) the prefix-only member is in the removal set, not just the meta-tagged file.
    expect(received?.fabFileIds).toContain(prefixOwned._id.toString());
    expect(received?.fabFileIds).toContain(metaTagged._id.toString());

    // c) THE KEY INVARIANT: what the port was told to remove is EXACTLY what Mongo actually lost -
    // no file destroyed behind the index's back, and no id claimed that survived.
    const stillPresent = await Promise.all(
      [metaTagged, prefixOwned, strangerFile].map(async f => ({
        id: f._id.toString(),
        present: await fileExists(f._id.toString()),
      }))
    );
    const actuallyDeletedIds = stillPresent.filter(f => !f.present).map(f => f.id);
    expect(actuallyDeletedIds.sort()).toEqual([...(received?.fabFileIds ?? [])].sort());

    // d) the stranger's same-prefix file was never a member and must survive.
    expect(await fileExists(strangerFile._id.toString())).toBe(true);
  });

  it('spares a file that became a member after the sweep resolved its ids', async () => {
    const { lake, prefixOwned } = await seedLake();
    let received: RetrievalIndexRemoval | undefined;
    let joiner: Awaited<ReturnType<typeof makeFile>> | undefined;
    const port: RetrievalIndexPort = {
      async removeForDataLake(input) {
        received = input;
        // The port runs after the sweep resolved its ids and before it destroys anything, so this
        // is the real mid-sweep window: the creator tags another of their files into the lake.
        joiner = await makeFile({ fileName: 'joined-mid-sweep.txt', userId: CREATOR, tags: [{ name: 'acme:late' }] });
      },
    };

    await runCleanup(lake._id.toString(), port);

    const joinerId = joiner!._id.toString();
    // Not vacuous: the joiner really does satisfy the membership predicate, so a purge that
    // re-resolved membership at delete time WOULD have taken it.
    const membersNow = await fabFileRepository.findIdsByDataLakeTag({
      datalakeTag: lake.datalakeTag,
      fileTagPrefix: lake.fileTagPrefix,
      creatorUserId: lake.createdByUserId,
    });
    expect(membersNow).toContain(joinerId);

    // It was never announced to the index, so destroying it would orphan its chunks and its entry.
    expect(received?.fabFileIds).not.toContain(joinerId);
    expect(await fileExists(joinerId)).toBe(true);
    // The members that WERE announced are gone, so this is not just a purge that did nothing.
    expect(await fileExists(prefixOwned._id.toString())).toBe(false);
  });

  it('a failing index aborts the purge before anything is destroyed', async () => {
    const { lake, metaTagged, prefixOwned, strangerFile } = await seedLake();
    const port: RetrievalIndexPort = {
      async removeForDataLake() {
        throw new Error('index unavailable');
      },
    };

    await expect(runCleanup(lake._id.toString(), port)).rejects.toThrow('index unavailable');

    for (const f of [metaTagged, prefixOwned, strangerFile]) {
      expect(await fileExists(f._id.toString())).toBe(true);
      expect(await fabFileChunkRepository.findByFabFileId(f._id.toString())).toHaveLength(1);
    }
  });
});
