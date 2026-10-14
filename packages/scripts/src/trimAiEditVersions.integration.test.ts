import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { FabFile } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';
import { trimAiEditVersions } from './trimAiEditVersions';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

const silent = () => undefined;

/** A file with v1 plus `edits` edited versions, current filePath = the newest. */
const seedFile = async (edits: number, over: Record<string, unknown> = {}) => {
  const _id = new mongoose.Types.ObjectId();
  const versions = Array.from({ length: edits + 1 }, (_, i) => ({
    version: i + 1,
    filePath: `files/u/${_id}/v${i + 1}`,
    fileSize: 10,
    mimeType: 'x',
    createdAt: new Date(0),
  }));
  await FabFile.collection.insertOne({
    _id,
    userId: 'u',
    fileName: 'report.docx',
    filePath: versions[versions.length - 1].filePath,
    versions,
    deletedAt: null,
    ...over,
  });
  return _id;
};

const versionsOf = async (id: mongoose.Types.ObjectId) =>
  ((await FabFile.collection.findOne({ _id: id }))?.versions as { version: number }[]).map(v => v.version);

describe('trimAiEditVersions', () => {
  it('dry run reports what would be trimmed without writing or deleting', async () => {
    const id = await seedFile(5);
    await seedFile(2);
    const storage = { delete: vi.fn().mockResolvedValue(undefined) };

    const result = await trimAiEditVersions({ dryRun: true, maxEditedVersions: 2, storage, log: silent });

    expect(result).toMatchObject({ files: 1, versions: 3, bytes: 30 });
    expect(await versionsOf(id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('apply keeps v1 plus the last N and deletes the dropped keys', async () => {
    const id = await seedFile(5);
    const storage = { delete: vi.fn().mockResolvedValue(undefined) };

    const result = await trimAiEditVersions({ dryRun: false, maxEditedVersions: 2, storage, log: silent });

    expect(result).toMatchObject({ files: 1, versions: 3, skipped: 0, deleteFailures: 0 });
    expect(await versionsOf(id)).toEqual([1, 5, 6]);
    expect(storage.delete.mock.calls.map(([key]) => key)).toEqual([
      `files/u/${id}/v2`,
      `files/u/${id}/v3`,
      `files/u/${id}/v4`,
    ]);
  });

  it('skips a row an edit changed between the read and the write, deleting nothing', async () => {
    const id = await seedFile(5);
    const storage = { delete: vi.fn().mockResolvedValue(undefined) };
    // A concurrent edit repoints filePath after the cursor read but before the conditional write.
    const original = FabFile.updateOne.bind(FabFile);
    const spy = vi
      .spyOn(FabFile, 'updateOne')
      .mockImplementationOnce(((filter: object, update: object) =>
        FabFile.collection
          .updateOne({ _id: id }, { $set: { filePath: 'files/u/newer' } })
          .then(() => original(filter, update))) as unknown as typeof FabFile.updateOne);

    const result = await trimAiEditVersions({ dryRun: false, maxEditedVersions: 2, storage, log: silent });

    spy.mockRestore();
    expect(result).toMatchObject({ files: 0, skipped: 1 });
    expect(await versionsOf(id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('skips a row that gained a version between the read and the write, deleting nothing', async () => {
    const id = await seedFile(5);
    const storage = { delete: vi.fn().mockResolvedValue(undefined) };
    // An edit appends a version but leaves filePath alone, so only the `$size` guard can catch it.
    const original = FabFile.updateOne.bind(FabFile);
    const spy = vi
      .spyOn(FabFile, 'updateOne')
      .mockImplementationOnce(((filter: object, update: object) =>
        FabFile.collection
          .updateOne(
            { _id: id },
            { $push: { versions: { version: 7, filePath: 'files/u/extra', fileSize: 10, mimeType: 'x' } } }
          )
          .then(() => original(filter, update))) as unknown as typeof FabFile.updateOne);

    const result = await trimAiEditVersions({ dryRun: false, maxEditedVersions: 2, storage, log: silent });

    spy.mockRestore();
    expect(result).toMatchObject({ files: 0, skipped: 1 });
    expect(await versionsOf(id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('ignores soft-deleted files', async () => {
    await seedFile(5, { deletedAt: new Date() });
    const storage = { delete: vi.fn() };

    const result = await trimAiEditVersions({ dryRun: false, maxEditedVersions: 2, storage, log: silent });

    expect(result.files).toBe(0);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('counts a failed object delete without undoing the trim', async () => {
    const id = await seedFile(3);
    const storage = { delete: vi.fn().mockRejectedValueOnce(new Error('s3 down')).mockResolvedValue(undefined) };

    const result = await trimAiEditVersions({ dryRun: false, maxEditedVersions: 2, storage, log: silent });

    expect(result).toMatchObject({ files: 1, deleteFailures: 1 });
    expect(await versionsOf(id)).toEqual([1, 3, 4]);
  });
});
