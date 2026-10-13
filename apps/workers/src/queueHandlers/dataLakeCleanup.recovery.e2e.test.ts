import { afterAll, afterEach, beforeAll, expect, it, vi, describe } from 'vitest';
import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import type { Context, SQSEvent } from 'aws-lambda';
import type { Logger } from '@bike4mind/observability';
import { KnowledgeType } from '@bike4mind/common';
import {
  dataLakeRepository,
  DataLakeModel,
  dataLakeAccessGrantRepository,
  dataLakeProposalRepository,
  FabFile,
  FabFileChunk,
  fabFileRepository,
} from '@bike4mind/database';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger:
    (fn: (event: SQSEvent, context: Context, logger: Logger) => Promise<void>) => (event: SQSEvent, context: Context) =>
      fn(event, context, { updateMetadata() {}, info() {}, warn() {}, error() {} } as unknown as Logger),
}));
const { objects } = vi.hoisted(() => ({ objects: new Map<string, string>() }));
const storage = {
  upload: async (body: string, key: string) => {
    objects.set(key, body);
  },
  delete: async (key: string) => {
    objects.delete(key);
  },
};
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => storage }));
vi.mock('@server/integrations/google/drive/common', () => ({ releaseDriveConnectionForLake: async () => false }));
vi.mock('@server/integrations/github/dataLake/githubLakeConnection', () => ({
  releaseGitHubLakeConnectionForLake: async () => null,
}));
vi.mock('@server/memory/ledgerMemoryStore', () => ({ shredPrincipalMemory: async () => {} }));
vi.mock('@server/memory/factCipher', () => ({ createKeyProvider: () => ({}) }));
import { dispatch } from './dataLakeCleanup';

describe('cleanup handler recovery with real replica-set Mongo', () => {
  let mongo: Awaited<ReturnType<typeof createMongoReplSet>>;
  const keys: string[] = [];
  beforeAll(async () => {
    mongo = await createMongoReplSet();
    await mongoose.connect(mongo.getUri(), { autoIndex: false });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    objects.clear();
    await mongoose.disconnect();
    await mongo?.stop();
  });
  const read = async (key: string) => {
    if (!objects.has(key)) throw Object.assign(new Error('missing object'), { name: 'NoSuchKey' });
    return objects.get(key);
  };
  const seed = async () => {
    const tag = `datalake:${randomUUID()}`;
    const lake = await dataLakeRepository.create({
      name: tag,
      slug: randomUUID(),
      datalakeTag: tag,
      fileTagPrefix: tag,
      createdByUserId: 'owner',
      status: 'deleted',
    });
    const key = `${randomUUID()}.txt`;
    const otherKey = `${randomUUID()}.txt`;
    keys.push(key, otherKey);
    await storage.upload('purge exact bytes', key);
    await storage.upload('other lake bytes', otherKey);
    const file = await FabFile.create({
      userId: 'owner',
      fileName: key,
      filePath: key,
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      fileSize: 17,
      status: 'complete',
      tags: [{ name: tag }],
      deletedAt: new Date(),
    });
    const other = await FabFile.create({
      userId: 'owner',
      fileName: otherKey,
      filePath: otherKey,
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      fileSize: 16,
      status: 'complete',
      tags: [{ name: `datalake:${randomUUID()}` }],
      deletedAt: new Date(),
    });
    await FabFileChunk.create({ fabFileId: file.id, text: 'purged chunk', tokenCount: 2 });
    await FabFileChunk.create({ fabFileId: other.id, text: 'other chunk', tokenCount: 2 });
    const claim = randomUUID();
    expect(await dataLakeRepository.claimPurging(lake.id, claim)).toBe(true);
    expect((await dataLakeRepository.findById(lake.id))?.purgeClaimId).toBe(claim);
    expect(
      await fabFileRepository.findIdsByDataLakeTag({
        kind: 'owned',
        datalakeTag: tag,
        fileTagPrefix: tag,
        creatorUserId: 'owner',
      })
    ).toEqual([file.id]);
    const event = {
      Records: [
        {
          body: JSON.stringify({ dataLakeId: lake.id, actor: { userId: 'owner', isAdmin: true }, purgeClaimId: claim }),
        },
      ],
    } as SQSEvent;
    return { lake, file, other, key, otherKey, claim, event };
  };
  it('removes actual target bytes, row and chunks; preserves another lake and tolerates duplicate delivery', async () => {
    const f = await seed();
    expect(await read(f.key)).toBe('purge exact bytes');
    await dispatch(f.event, {} as Context);
    await expect(read(f.key)).rejects.toMatchObject({ name: 'NoSuchKey' });
    expect(await FabFile.collection.findOne({ _id: f.file._id })).toBeNull();
    expect(await FabFileChunk.countDocuments({ fabFileId: f.file.id })).toBe(0);
    expect(await dataLakeRepository.findById(f.lake.id)).toBeNull();
    await dispatch(f.event, {} as Context);
    expect(await read(f.otherKey)).toBe('other lake bytes');
    expect(await FabFile.collection.findOne({ _id: f.other._id })).not.toBeNull();
    expect(await FabFileChunk.countDocuments({ fabFileId: f.other.id })).toBe(1);
  });
  it('retains the retry locator and started claim after storage failure, then converges on replay', async () => {
    const f = await seed();
    const original = storage.delete;
    vi.spyOn(storage, 'delete').mockImplementationOnce(async () => {
      throw new Error('object delete interrupted');
    });
    await expect(dispatch(f.event, {} as Context)).rejects.toThrow('object delete interrupted');
    expect(await read(f.key)).toBe('purge exact bytes');
    expect(await FabFile.collection.findOne({ _id: f.file._id })).not.toBeNull();
    expect(await dataLakeRepository.releasePurgingToDeleted(f.lake.id, f.claim)).toBe(false);
    storage.delete = original;
    await dispatch(f.event, {} as Context);
    await expect(read(f.key)).rejects.toMatchObject({ name: 'NoSuchKey' });
    expect(await dataLakeRepository.findById(f.lake.id)).toBeNull();
  });
  it('rolls back row removal on chunk failure and replays after objects were already removed', async () => {
    const f = await seed();
    vi.spyOn(FabFileChunk, 'deleteMany').mockImplementationOnce(() => {
      throw new Error('chunk write interrupted');
    });
    await expect(dispatch(f.event, {} as Context)).rejects.toThrow('chunk write interrupted');
    expect(await FabFile.collection.findOne({ _id: f.file._id })).not.toBeNull();
    expect(await FabFileChunk.countDocuments({ fabFileId: f.file.id })).toBe(1);
    await expect(read(f.key)).rejects.toMatchObject({ name: 'NoSuchKey' });
    vi.restoreAllMocks();
    await dispatch(f.event, {} as Context);
    expect(await FabFile.collection.findOne({ _id: f.file._id })).toBeNull();
    expect(await FabFileChunk.countDocuments({ fabFileId: f.file.id })).toBe(0);
  });
  it('acknowledges a stale generation without destroying objects or releasing the current claim', async () => {
    const f = await seed();
    await dataLakeRepository.releasePurgingToDeleted(f.lake.id, f.claim);
    await dataLakeRepository.claimPurging(f.lake.id, 'new-generation');
    await dispatch(f.event, {} as Context);
    expect(await read(f.key)).toBe('purge exact bytes');
    expect((await dataLakeRepository.findById(f.lake.id))?.purgeClaimId).toBe('new-generation');
    expect(await FabFileChunk.countDocuments({ fabFileId: f.file.id })).toBe(1);
  });
  it.each(['keyed', 'legacy'])(
    'replays the same started %s grant-manager generation after its grants were removed',
    async kind => {
      const f = await seed();
      await dataLakeAccessGrantRepository.upsertGrant({
        dataLakeId: f.lake.id,
        principalType: 'user',
        principalId: 'curator',
        role: 'curator',
        grantedByUserId: 'owner',
      });
      const body = JSON.parse(f.event.Records[0].body);
      body.actor = { userId: 'curator', isAdmin: false };
      if (kind === 'legacy') {
        await DataLakeModel.updateOne({ _id: f.lake.id }, { $unset: { purgeClaimId: 1 } });
        expect((await dataLakeRepository.findById(f.lake.id))?.purgeClaimId).toBeUndefined();
        delete body.purgeClaimId;
      }
      f.event.Records[0].body = JSON.stringify(body);
      vi.spyOn(dataLakeProposalRepository, 'deleteForLake').mockRejectedValueOnce(new Error('post-grant failure'));
      await expect(dispatch(f.event, {} as Context)).rejects.toThrow('post-grant failure');
      expect(await dataLakeAccessGrantRepository.listByLake(f.lake.id)).toEqual([]);
      expect((await dataLakeRepository.findById(f.lake.id))?.purgeStartedAt).toBeTruthy();
      const wrong = { Records: [{ body: JSON.stringify({ ...body, purgeClaimId: 'wrong-generation' }) }] } as SQSEvent;
      await dispatch(wrong, {} as Context);
      expect(await dataLakeRepository.findById(f.lake.id)).not.toBeNull();
      await dispatch(f.event, {} as Context);
      expect(await dataLakeRepository.findById(f.lake.id)).toBeNull();
      expect(await read(f.otherKey)).toBe('other lake bytes');
    }
  );
});
