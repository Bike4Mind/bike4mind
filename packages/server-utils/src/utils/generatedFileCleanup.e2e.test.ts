import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { FabFile, GeneratedFileCleanupModel } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
const effects = vi.hoisted(() => ({ deleteFile: vi.fn(), deleteFileCount: vi.fn() }));
vi.mock('./storage/index', () => ({
  getFilesStorage: () => ({
    deletePermanently: effects.deleteFile,
    deletePermanentlyWithCount: effects.deleteFileCount,
  }),
}));
import {
  deleteRememberedGeneratedFile,
  rememberGeneratedFileCleanup,
  retryGeneratedFileCleanup,
} from './generatedFileCleanup';
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let database: Awaited<ReturnType<typeof createMongoServer>>;
const path = 'generated-video/12345678-1234-1234-1234-123456789abc.mp4';
const logger = { error: vi.fn() };
beforeAll(async () => {
  database = await createMongoServer();
  await mongoose.connect(database.getUri());
  await GeneratedFileCleanupModel.createIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  effects.deleteFile.mockReset().mockResolvedValue(undefined);
  effects.deleteFileCount.mockReset().mockResolvedValue(0);
  await GeneratedFileCleanupModel.collection.deleteMany({});
  await FabFile.collection.deleteMany({});
});
describe('durable generated Files compensation receipts', () => {
  it('keeps the exact path on storage failure and retries without a creator, notebook or opted-in organization', async () => {
    await rememberGeneratedFileCleanup(path);
    await rememberGeneratedFileCleanup(path);
    effects.deleteFile.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(deleteRememberedGeneratedFile(path)).rejects.toThrow('storage unavailable');
    expect(await GeneratedFileCleanupModel.countDocuments({ filePath: path })).toBe(1);
    expect(await retryGeneratedFileCleanup({ logger })).toBe(1);
    expect(await GeneratedFileCleanupModel.countDocuments({})).toBe(0);
    expect(effects.deleteFile.mock.calls).toEqual([[path], [path]]);
  });
  it('keeps an ambiguous upload locator after an empty sweep so a later commit can still be erased', async () => {
    await rememberGeneratedFileCleanup(path, { ambiguousUpload: true });
    expect(await retryGeneratedFileCleanup({ logger })).toBe(0);
    expect(await GeneratedFileCleanupModel.countDocuments({ filePath: path, ambiguousUpload: true })).toBe(1);
    effects.deleteFileCount.mockResolvedValueOnce(2);
    expect(await retryGeneratedFileCleanup({ logger })).toBe(1);
    expect(await GeneratedFileCleanupModel.countDocuments({})).toBe(0);
    expect(effects.deleteFile).not.toHaveBeenCalled();
  });

  it('retains a receipt when removing it fails after object deletion and safely retries the same key', async () => {
    await rememberGeneratedFileCleanup(path);
    vi.spyOn(GeneratedFileCleanupModel.collection, 'deleteOne').mockRejectedValueOnce(
      new Error('database unavailable')
    );
    await expect(deleteRememberedGeneratedFile(path)).rejects.toThrow('database unavailable');
    expect(await GeneratedFileCleanupModel.countDocuments({ filePath: path })).toBe(1);
    expect(await retryGeneratedFileCleanup({ logger })).toBe(1);
    expect(effects.deleteFile).toHaveBeenCalledTimes(2);
  });
  it.each(['current', 'version', 'held'] as const)('does not delete a %s file reference', async kind => {
    await rememberGeneratedFileCleanup(path);
    await FabFile.collection.insertOne({
      userId: 'owner',
      fileName: 'retained.mp4',
      ...(kind === 'version' ? { versions: [{ filePath: path }] } : { filePath: path }),
      ...(kind === 'held' ? { deletedAt: new Date(), legalHold: true } : { deletedAt: null }),
    });
    expect(await deleteRememberedGeneratedFile(path)).toBe(false);
    expect(effects.deleteFile).not.toHaveBeenCalled();
    expect(await GeneratedFileCleanupModel.countDocuments({})).toBe(0);
  });
  it.each(['../private', 'uploads/12345678-1234-1234-1234-123456789abc.mp4', 'generated-video/customer.mp4'])(
    'rejects unsafe retry path %s',
    async invalid => {
      await expect(rememberGeneratedFileCleanup(invalid)).rejects.toThrow();
      await expect(deleteRememberedGeneratedFile(invalid)).rejects.toThrow();
      expect(effects.deleteFile).not.toHaveBeenCalled();
    }
  );
  it('leaves malformed raw receipts intact and fails closed without deleting arbitrary objects', async () => {
    await GeneratedFileCleanupModel.collection.insertOne({ filePath: 'uploads/private', createdAt: new Date() });
    await expect(retryGeneratedFileCleanup({ logger })).rejects.toThrow('1 object');
    expect(effects.deleteFile).not.toHaveBeenCalled();
    expect(await GeneratedFileCleanupModel.countDocuments({})).toBe(1);
  });
  it('rotates a failed page so the fifty-item limit cannot starve a later receipt', async () => {
    const paths = Array.from(
      { length: 51 },
      (_, index) => `generated/${index.toString(16).padStart(8, '0')}-1234-1234-1234-123456789abc.png`
    );
    for (const filePath of paths) await rememberGeneratedFileCleanup(filePath);
    effects.deleteFile.mockRejectedValue(new Error('storage unavailable'));
    await expect(retryGeneratedFileCleanup({ logger })).rejects.toThrow('50 object');
    expect(effects.deleteFile).toHaveBeenCalledTimes(50);
    effects.deleteFile.mockReset().mockResolvedValue(undefined);
    effects.deleteFileCount.mockReset().mockResolvedValue(0);
    expect(await retryGeneratedFileCleanup({ logger })).toBe(50);
    expect(effects.deleteFile.mock.calls[0]).toEqual([paths[50]]);
    expect(await GeneratedFileCleanupModel.countDocuments({})).toBe(1);
    expect(await retryGeneratedFileCleanup({ deadline: Date.now() - 1, logger })).toBe(0);
  });
});
