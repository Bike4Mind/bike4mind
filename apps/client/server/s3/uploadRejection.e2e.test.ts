import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { FabFile, DataLakeBatchModel, dataLakeBatchRepository } from '@bike4mind/database';
import { KnowledgeType } from '@bike4mind/common';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { admitLandedUpload, rejectLandedUpload } from '@bike4mind/server-utils/s3/uploadSizeGate';
import { recordRejectedUploadBatch } from './recordRejectedUploadBatch';

const h = vi.hoisted(() => ({ deleteObject: vi.fn(), sendToClient: vi.fn(), finalize: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({ getFilesStorage: () => ({ delete: h.deleteObject }) }));
vi.mock('@bike4mind/server-utils/websocket/utils', () => ({ sendToClient: h.sendToClient }));
vi.mock('@server/dataLakes/dataLakeBatchProgress', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  finalizeBatchIfComplete: h.finalize,
}));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'wss://test' } } }));

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer;
const logger = { warn: vi.fn(), error: vi.fn() };

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

const seedFile = (fields: Record<string, unknown> = {}) =>
  FabFile.create({
    userId: 'u1',
    fileName: 'f.pdf',
    type: KnowledgeType.FILE,
    filePath: 'uploads/f.pdf',
    status: 'pending',
    clientUpload: true,
    ...fields,
  });

const findLanding = (filePath: string) =>
  FabFile.findOne({ filePath, $or: [{ deletedAt: null }, { uploadRejectedAt: { $ne: null } }] }, null, {
    includeDeleted: true,
  });

describe('rejected upload cleanup', () => {
  it('retries a transient delete failure through the event lookup after soft deletion', async () => {
    const file = await seedFile();
    h.deleteObject.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(rejectLandedUpload(file._id, file.filePath!)).rejects.toThrow('storage unavailable');
    expect(await FabFile.findById(file._id)).toBeNull();
    const retry = await findLanding(file.filePath!);
    expect(retry?.uploadRejectedAt).toBeInstanceOf(Date);

    expect(await admitLandedUpload(retry!, 42, file.filePath!, logger)).toBe(false);
    expect(h.deleteObject).toHaveBeenCalledTimes(2);
    expect(await FabFile.findById(file._id)).toBeNull();
  });

  it('deletes a replayed PUT even after the original rejection cleanup succeeded', async () => {
    const file = await seedFile();
    await rejectLandedUpload(file._id, file.filePath!);
    const replay = await findLanding(file.filePath!);

    expect(await admitLandedUpload(replay!, 42, file.filePath!, logger)).toBe(false);
    expect(h.deleteObject).toHaveBeenCalledTimes(2);
  });

  it('keeps a file that completed before the rejection claim', async () => {
    const file = await seedFile({ status: 'complete' });

    expect(await rejectLandedUpload(file._id, file.filePath!)).toBe(false);
    expect(h.deleteObject).not.toHaveBeenCalled();
    expect((await FabFile.findById(file._id))?.uploadRejectedAt).toBeUndefined();
  });

  it('excludes ordinary user-deleted rows from rejection cleanup', async () => {
    const file = await seedFile({ deletedAt: new Date() });

    expect(await findLanding(file.filePath!)).toBeNull();
    expect(await rejectLandedUpload(file._id, file.filePath!)).toBe(false);
    expect(h.deleteObject).not.toHaveBeenCalled();
  });
});

const seedBatch = (status = 'processing', fileStatus = 'pending') =>
  DataLakeBatchModel.create({
    userId: 'u1',
    dataLakeId: 'lake1',
    totalFiles: 1,
    status,
    files: [{ fabFileId: 'ff1', fileName: 'f.pdf', status: fileStatus }],
  });

describe('rejected upload batch accounting', () => {
  it('atomically counts a rejected manifest entry once under concurrent redelivery', async () => {
    const batch = await seedBatch();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => dataLakeBatchRepository.rejectPendingUpload(batch.id, 'ff1', 'over quota'))
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    const fresh = await dataLakeBatchRepository.findById(batch.id);
    expect(fresh?.failedFiles).toBe(1);
    expect(fresh?.files[0]).toMatchObject({ status: 'failed', error: 'over quota', failureCounted: true });
  });

  it.each(['cancelled', 'failed', 'completed', 'completed_with_errors'])('leaves a %s batch settled', async status => {
    const batch = await seedBatch(status);
    expect(await dataLakeBatchRepository.rejectPendingUpload(batch.id, 'ff1', 'over quota')).toBeNull();
    expect((await dataLakeBatchRepository.findById(batch.id))?.failedFiles).toBe(0);
  });

  it.each(['uploaded', 'chunking', 'complete', 'failed', 'skipped'])(
    'does not count a manifest entry already %s',
    async status => {
      const batch = await seedBatch('processing', status);
      expect(await dataLakeBatchRepository.rejectPendingUpload(batch.id, 'ff1', 'over quota')).toBeNull();
      expect((await dataLakeBatchRepository.findById(batch.id))?.failedFiles).toBe(0);
    }
  );

  it('retries finalization after the failure was counted without incrementing it twice', async () => {
    const batch = await seedBatch();
    const file = { _id: 'ff1', userId: 'u1', batchId: batch.id };
    h.finalize.mockRejectedValueOnce(new Error('finalization unavailable'));

    await expect(recordRejectedUploadBatch(file, logger)).rejects.toThrow('finalization unavailable');
    await recordRejectedUploadBatch(file, logger);

    expect((await dataLakeBatchRepository.findById(batch.id))?.failedFiles).toBe(1);
    expect(h.finalize).toHaveBeenCalledTimes(2);
    expect(h.sendToClient).toHaveBeenCalledWith('u1', 'wss://test', {
      action: 'data_lake_batch_progress',
      batchId: batch.id,
      failedFiles: 1,
      status: 'completed_with_errors',
    });
  });

  it('retries notification after the failure was counted', async () => {
    const batch = await seedBatch();
    const file = { _id: 'ff1', userId: 'u1', batchId: batch.id };
    h.sendToClient.mockRejectedValueOnce(new Error('websocket unavailable'));

    await expect(recordRejectedUploadBatch(file, logger)).rejects.toThrow('websocket unavailable');
    await recordRejectedUploadBatch(file, logger);

    expect((await dataLakeBatchRepository.findById(batch.id))?.failedFiles).toBe(1);
    expect(h.sendToClient).toHaveBeenCalledTimes(2);
  });

  it('does nothing for uploads outside a batch', async () => {
    await recordRejectedUploadBatch({ _id: 'ff1', userId: 'u1' }, logger);
    expect(h.finalize).not.toHaveBeenCalled();
    expect(h.sendToClient).not.toHaveBeenCalled();
  });
});
