import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  FabFile,
  GeneratedFileCleanupModel,
  Organization,
  OrganizationGeneratedObject,
  Session,
  User,
  eraseOrganizationRetentionForUser,
  withTransaction,
} from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import type { SaveGeneratedAssetParams } from '@bike4mind/services';
const h = vi.hoisted(() => ({ upload: vi.fn(), deleteFile: vi.fn(), deleteFileCount: vi.fn() }));
vi.mock('./storage/index', () => ({
  getFilesStorage: () => ({
    upload: h.upload,
    deletePermanently: h.deleteFile,
    deletePermanentlyWithCount: h.deleteFileCount,
    getSignedUrl: async () => 'https://files.example.test/generated',
  }),
}));
import { saveGeneratedAssetToFiles } from './saveGeneratedAssetToFiles';
import { retryGeneratedFileCleanup } from './generatedFileCleanup';
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let database: Awaited<ReturnType<typeof createMongoReplSet>>;
const userId = 'abcdefabcdefabcdefabcdef';
const organizationId = 'fedcbafedcbafedcbafedcba';
const sessionId = '123456781234567812345678';
const inlineKey = '12345678-1234-1234-1234-123456789abc.mp4';
const objects = new Set<string>();
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
function barrier() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return {
    promise,
    release: () => {
      if (!release) throw new Error('Barrier not initialized');
      release();
    },
  };
}
function parameters(signal?: AbortSignal): SaveGeneratedAssetParams {
  return {
    userId,
    sessionId,
    generatedCopyKey: inlineKey,
    bytes: Buffer.from('provider-video'),
    contentType: 'video/mp4',
    generation: { generator: 'video', provider: 'veo', jobId: 'disposable-job', prompt: 'disposable generated scene' },
    signal,
  };
}
beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await GeneratedFileCleanupModel.createIndexes();
  await OrganizationGeneratedObject.createIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  h.upload.mockReset();
  h.deleteFile.mockReset();
  h.deleteFileCount.mockReset().mockImplementation(async (path: string) => {
    const count = objects.has(path) ? 1 : 0;
    objects.delete(path);
    return count;
  });
  objects.clear();
  h.upload.mockImplementation(async (_content: Buffer, path: string) => {
    objects.add(path);
  });
  h.deleteFile.mockImplementation(async (path: string) => {
    objects.delete(path);
  });
  for (const model of [FabFile, GeneratedFileCleanupModel, Organization, OrganizationGeneratedObject, Session, User])
    await model.collection.deleteMany({});
  await User.collection.insertOne({
    _id: new mongoose.Types.ObjectId(userId),
    username: 'creator',
    name: 'Creator',
    currentStorageSize: 0,
    storageLimit: 100_000_000,
  });
  await Organization.create({
    _id: new mongoose.Types.ObjectId(organizationId),
    userId,
    name: 'Team',
    personal: false,
    storageLimit: 100_000_000,
    currentStorageSize: 0,
  });
  await Session.collection.insertOne({
    _id: new mongoose.Types.ObjectId(sessionId),
    userId,
    name: 'Notebook',
    retentionOrganizationId: organizationId,
  });
});
describe('actual generated Files writer and erasure over local Mongo', () => {
  it('persists the Files copy through the real service when the creator remains active', async () => {
    const result = await saveGeneratedAssetToFiles(parameters(), logger);
    expect(result.saved).toBe(true);
    const saved = await FabFile.findOne({ userId }).lean();
    expect(saved?.sourceMetadata?.retentionOrganizationId).toBe(organizationId);
    expect(saved?.organizationId).not.toBe(organizationId);
    expect((await Organization.findById(organizationId).lean())?.currentStorageSize).toBe(0);
    expect(await GeneratedFileCleanupModel.countDocuments({})).toBe(0);
    expect((await OrganizationGeneratedObject.findOne({ key: inlineKey }).lean())?.userId).toBe(userId);
  });
  it.each([
    { abort: false, lateCommit: false },
    { abort: true, lateCommit: false },
    { abort: false, lateCommit: true },
    { abort: true, lateCommit: true },
  ])(
    'retains a rejected upload through erasure (abort=$abort, lateCommit=$lateCommit)',
    async ({ abort, lateCommit }) => {
      const uploading = barrier();
      const finishUpload = barrier();
      const controller = new AbortController();
      const uploadError = Object.assign(new Error('remote upload response lost'), {
        name: abort ? 'AbortError' : 'Error',
      });
      h.upload.mockImplementation(async (_content: Buffer, path: string) => {
        uploading.release();
        await finishUpload.promise;
        if (!lateCommit) objects.add(path);
        throw uploadError;
      });
      const pending = saveGeneratedAssetToFiles(parameters(controller.signal), logger);
      await uploading.promise;
      await withTransaction(async transaction => {
        await eraseOrganizationRetentionForUser(userId, { session: transaction });
        await Session.deleteOne({ _id: sessionId }, { session: transaction });
        await User.deleteOne({ _id: userId }, { session: transaction });
      });
      if (abort) controller.abort();
      finishUpload.release();
      if (abort) await expect(pending).rejects.toBe(uploadError);
      else await expect(pending).resolves.toMatchObject({ saved: false, reason: 'error' });
      expect(await FabFile.countDocuments({})).toBe(0);
      expect(await User.countDocuments({})).toBe(0);
      const receipts = await GeneratedFileCleanupModel.find().lean();
      expect(receipts).toHaveLength(1);
      expect(receipts[0].ambiguousUpload).toBe(true);
      expect(JSON.stringify(receipts)).not.toContain(userId);
      expect(JSON.stringify(receipts)).not.toContain(sessionId);
      if (lateCommit) {
        expect(await retryGeneratedFileCleanup()).toBe(0);
        expect(await GeneratedFileCleanupModel.countDocuments({})).toBe(1);
        objects.add(receipts[0].filePath);
      }
      expect(await retryGeneratedFileCleanup()).toBe(1);
      expect(objects.size).toBe(0);
      expect(await GeneratedFileCleanupModel.countDocuments({})).toBe(0);
      expect(await OrganizationGeneratedObject.countDocuments({ key: inlineKey, deletedAt: null })).toBe(1);
    }
  );

  it.each([false, true])(
    'fences a creator erased during upload and durably retries failed compensation (abort=%s)',
    async abort => {
      const uploading = barrier();
      const finishUpload = barrier();
      const controller = new AbortController();
      h.upload.mockImplementation(async (_content: Buffer, path: string) => {
        uploading.release();
        await finishUpload.promise;
        objects.add(path);
      });
      const pending = saveGeneratedAssetToFiles(parameters(controller.signal), logger);
      await uploading.promise;
      // This transaction finishes before the storage barrier is released: no User lock spans upload I/O.
      await withTransaction(async transaction => {
        await eraseOrganizationRetentionForUser(userId, { session: transaction });
        await Session.deleteOne({ _id: sessionId }, { session: transaction });
        await User.deleteOne({ _id: userId }, { session: transaction });
      });
      if (abort) controller.abort();
      h.deleteFile.mockRejectedValueOnce(new Error('temporary delete failure'));
      finishUpload.release();
      await expect(pending).rejects.toThrow('temporary delete failure');
      expect(await FabFile.countDocuments({})).toBe(0);
      expect(await User.countDocuments({})).toBe(0);
      const receipts = await GeneratedFileCleanupModel.find().lean();
      expect(receipts).toHaveLength(1);
      expect(objects.has(receipts[0].filePath)).toBe(true);
      expect(receipts[0].filePath).not.toBe(inlineKey);
      expect(JSON.stringify(receipts)).not.toContain(userId);
      expect(JSON.stringify(receipts)).not.toContain(sessionId);
      expect((await OrganizationGeneratedObject.findOne({ key: inlineKey }).lean())?.userId).toBe('deleted-account');
      expect(await retryGeneratedFileCleanup()).toBe(1);
      expect(objects.size).toBe(0);
      expect(await GeneratedFileCleanupModel.countDocuments({})).toBe(0);
      expect(await OrganizationGeneratedObject.countDocuments({ key: inlineKey, deletedAt: null })).toBe(1);
    }
  );
});
