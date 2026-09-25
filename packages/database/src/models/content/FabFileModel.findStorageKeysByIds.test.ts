import { describe, it, expect } from 'vitest';
import { KnowledgeType } from '@bike4mind/common';
import { setupMongoTest } from '../../__test__/utils';
import { FabFile, fabFileRepository } from './FabFileModel';

/**
 * `cleanupDeletedDataLake` reads each purged file's object keys through this method, and every id it
 * passes is ALREADY soft-deleted (by `deleteDataLake`). The soft-delete plugin hides those rows from
 * `findById`, so these cases seed soft-deleted rows and assert the keys still come back.
 */
describe('FabFileRepository.findStorageKeysByIds', () => {
  setupMongoTest();

  const makeFile = (filePath: string, versions: string[] = []) =>
    FabFile.create({
      userId: 'u-purge-owner',
      fileName: 'doc.txt',
      filePath,
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      fileSize: 100,
      status: 'complete',
      versions: versions.map((path, i) => ({
        version: i + 1,
        filePath: path,
        fileSize: 100,
        mimeType: 'text/plain',
        createdAt: new Date(),
      })),
    });

  const softDelete = (id: unknown) => FabFile.collection.updateOne({ _id: id }, { $set: { deletedAt: new Date() } });

  it("returns a soft-deleted row's current and prior-version keys, which findById cannot see", async () => {
    const file = await makeFile('org/doc-v2.txt', ['org/doc-v1.txt']);
    await softDelete(file._id);

    // The failure mode, pinned: the read the first cut of the purge used returns nothing here.
    expect(await fabFileRepository.findById(file._id.toString())).toBeNull();

    await expect(fabFileRepository.findStorageKeysByIds([file._id.toString()])).resolves.toEqual([
      { id: file._id.toString(), filePath: 'org/doc-v2.txt', versions: [{ filePath: 'org/doc-v1.txt' }] },
    ]);
  });

  it('returns live and soft-deleted rows alike, and nothing for an id with no row', async () => {
    const live = await makeFile('org/live.txt');
    const deleted = await makeFile('org/deleted.txt');
    await softDelete(deleted._id);
    const missing = '0123456789abcdef01234567';

    const rows = await fabFileRepository.findStorageKeysByIds([live._id.toString(), deleted._id.toString(), missing]);

    expect(rows.map(row => row.filePath).sort()).toEqual(['org/deleted.txt', 'org/live.txt']);
  });

  it('short-circuits an empty id list without a query', async () => {
    await expect(fabFileRepository.findStorageKeysByIds([])).resolves.toEqual([]);
  });
});
