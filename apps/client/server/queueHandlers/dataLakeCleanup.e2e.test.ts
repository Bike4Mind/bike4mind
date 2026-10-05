import { afterAll, afterEach, beforeAll, expect, it, vi, describe } from 'vitest';
import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import type { Context, SQSEvent } from 'aws-lambda';
import type { Logger } from '@bike4mind/observability';
import { KnowledgeType } from '@bike4mind/common';
import { S3Storage, createS3Client } from '@bike4mind/fab-pipeline';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { dataLakeRepository, FabFile, FabFileChunk, fabFileChunkRepository } from '@bike4mind/database';
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
vi.mock('sst', () => ({ Resource: { fabFileBucket: { name: process.env.CLEANUP_TEST_S3_BUCKET } } }));
vi.mock('@server/integrations/google/drive/common', () => ({ releaseDriveConnectionForLake: async () => false }));
vi.mock('@server/integrations/github/dataLake/githubLakeConnection', () => ({
  releaseGitHubLakeConnectionForLake: async () => null,
}));
vi.mock('@server/memory/ledgerMemoryStore', () => ({ shredPrincipalMemory: async () => {} }));
vi.mock('@server/memory/factCipher', () => ({ createKeyProvider: () => ({}) }));
import { dispatch } from './dataLakeCleanup';

const endpoint = process.env.CLEANUP_TEST_S3_ENDPOINT;
const bucket = process.env.CLEANUP_TEST_S3_BUCKET;
// Explicit external-service lane. The runbook starts an isolated MinIO before invoking this file.
describe.skipIf(!endpoint || !bucket)('cleanup handler with replica-set Mongo and real object storage', () => {
  let mongo: Awaited<ReturnType<typeof createMongoReplSet>>;
  let storage: S3Storage;
  let client: ReturnType<typeof createS3Client>;
  const keys: string[] = [];
  beforeAll(async () => {
    if (!endpoint || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(endpoint))
      throw new Error('Disposable loopback S3 required');
    vi.stubEnv('AWS_ENDPOINT_URL_S3', endpoint);
    mongo = await createMongoReplSet();
    await mongoose.connect(mongo.getUri());
    storage = new S3Storage(bucket!);
    client = createS3Client({ endpoint, forcePathStyle: true });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    for (const key of keys) await storage.delete(key);
    client?.destroy();
    await mongoose.disconnect();
    await mongo?.stop();
    vi.unstubAllEnvs();
  });
  const read = async (key: string) =>
    (await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body!.transformToString();
  const seed = async () => {
    const tag = `datalake:${randomUUID()}`;
    const lake = await dataLakeRepository.create({
      name: tag,
      slug: randomUUID(),
      datalakeTag: tag,
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
      metaTags: [tag],
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
      metaTags: [`datalake:${randomUUID()}`],
      deletedAt: new Date(),
    });
    await FabFileChunk.create({ fabFileId: file.id, text: 'purged chunk', tokenCount: 2 });
    await FabFileChunk.create({ fabFileId: other.id, text: 'other chunk', tokenCount: 2 });
    const claim = randomUUID();
    await dataLakeRepository.claimPurging(lake.id, claim);
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
    const original = S3Storage.prototype.delete;
    vi.spyOn(S3Storage.prototype, 'delete').mockImplementationOnce(async () => {
      throw new Error('object delete interrupted');
    });
    await expect(dispatch(f.event, {} as Context)).rejects.toThrow('object delete interrupted');
    expect(await read(f.key)).toBe('purge exact bytes');
    expect(await FabFile.collection.findOne({ _id: f.file._id })).not.toBeNull();
    expect(await dataLakeRepository.releasePurgingToDeleted(f.lake.id, f.claim)).toBe(false);
    S3Storage.prototype.delete = original;
    await dispatch(f.event, {} as Context);
    await expect(read(f.key)).rejects.toMatchObject({ name: 'NoSuchKey' });
    expect(await dataLakeRepository.findById(f.lake.id)).toBeNull();
  });
  it('rolls back row removal on chunk failure and replays after objects were already removed', async () => {
    const f = await seed();
    vi.spyOn(fabFileChunkRepository, 'deleteManyByFabFileId').mockRejectedValueOnce(
      new Error('chunk write interrupted')
    );
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
});
