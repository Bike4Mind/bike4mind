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
 * port was actually told to remove against what really left Mongo - and, for a file that joins the
 * lake mid-sweep, that the tag sparing it leaves behind does not outlive the lake it names.
 * Every unit layer here mocks its
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

    // e) the sweep's chunk step ran on the same set - a purged file with chunks left behind is
    // the orphan this whole change is about, just in the chunk store instead of the index.
    for (const f of [metaTagged, prefixOwned]) {
      expect(await fabFileChunkRepository.findByFabFileId(f._id.toString())).toHaveLength(0);
    }
    expect(await fabFileChunkRepository.findByFabFileId(strangerFile._id.toString())).toHaveLength(1);
  });

  /**
   * Purges the lake with a port that tags a fresh file into it mid-sweep - the real window between
   * the id resolve and the hard delete - and returns the joiner plus what the port was told.
   */
  async function purgeWithMidSweepJoiner(lake: Awaited<ReturnType<typeof seedLake>>['lake']) {
    let received: RetrievalIndexRemoval | undefined;
    let joiner: Awaited<ReturnType<typeof makeFile>> | undefined;
    const port: RetrievalIndexPort = {
      async removeForDataLake(input) {
        received = input;
        joiner = await makeFile({
          fileName: 'joined-mid-sweep.txt',
          userId: CREATOR,
          tags: [{ name: 'acme:late' }, { name: 'quarterly' }],
        });
      },
    };

    await runCleanup(lake._id.toString(), port);
    return { joiner: joiner!, received };
  }

  it('spares a file that became a member after the sweep resolved its ids', async () => {
    const { lake, prefixOwned } = await seedLake();

    const { joiner, received } = await purgeWithMidSweepJoiner(lake);

    const joinerId = joiner._id.toString();
    // It was never announced to the index, so destroying it would orphan its chunks and its entry.
    expect(received?.fabFileIds).not.toContain(joinerId);
    expect(await fileExists(joinerId)).toBe(true);
    // The members that WERE announced are gone, so this is not just a purge that did nothing.
    expect(await fileExists(prefixOwned._id.toString())).toBe(false);
  });

  it('strips the dead lake prefix off the survivor, leaving its other tags alone', async () => {
    const { lake } = await seedLake();
    const scope = {
      datalakeTag: lake.datalakeTag,
      fileTagPrefix: lake.fileTagPrefix,
      creatorUserId: lake.createdByUserId,
    };

    const { joiner } = await purgeWithMidSweepJoiner(lake);

    const tagsNow = (await FabFile.findById(joiner._id))?.tags?.map(t => t.name) ?? [];
    expect(tagsNow).not.toContain('acme:late');
    // Only this lake's signals go. The file itself is untouched everywhere else it is used.
    expect(tagsNow).toContain('quarterly');

    // Not vacuous: the predicate still selects exactly this shape of file, so the joiner dropping
    // out of it is the strip, not a predicate that never matched it in the first place.
    const control = await makeFile({ fileName: 'control.txt', userId: CREATOR, tags: [{ name: 'acme:control' }] });
    expect(await fabFileRepository.findIdsByDataLakeTag(scope)).toEqual([control._id.toString()]);
  });

  it('a later lake claiming the purged prefix does not adopt the survivor', async () => {
    const { lake } = await seedLake();

    const { joiner } = await purgeWithMidSweepJoiner(lake);

    // The create-time guard cannot help here: it only compares against lakes that still exist, and
    // the purged one is gone, so 'acme:' is free to claim again.
    expect(
      await dataLakeService.findCollidingPrefixLakes({ dataLakes: dataLakeRepository }, 'acme:', {
        createdByUserId: CREATOR,
      })
    ).toEqual([]);

    const successor = await DataLakeModel.create({
      name: 'Acme Docs II',
      slug: `acme-docs-ii-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      fileTagPrefix: 'acme:',
      datalakeTag: `datalake:acme-docs-ii-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      createdByUserId: CREATOR,
      status: 'active',
    });

    const members = await fabFileRepository.findIdsByDataLakeTag({
      datalakeTag: successor.datalakeTag,
      fileTagPrefix: successor.fileTagPrefix,
      creatorUserId: successor.createdByUserId,
    });
    expect(members).not.toContain(joiner._id.toString());
    expect(members).toEqual([]);
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
