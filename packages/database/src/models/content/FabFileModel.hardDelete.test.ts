import { describe, it, expect } from 'vitest';
import { KnowledgeType } from '@bike4mind/common';
import { setupMongoTest } from '../../__test__/utils';
import { FabFile, fabFileRepository } from './FabFileModel';

/**
 * `hardDeleteOneById` is the only `findOneAndDelete` + `hardDelete: true` pairing in the repo (every
 * other hard delete goes through `deleteMany`/`deleteOne` and a different plugin hook), and until
 * this file every test that reached it replaced it with a `vi.fn()`. Its two production callers
 * lean on different halves of its contract:
 *   - `purgeDataLakeDocument` consumes the boolean as `deletedByThisCall`, which gates the owner's
 *     quota refund, then verifies the purge with `findById`.
 *   - `cleanupDeletedDataLake` discards the boolean and needs only the row gone - over an id list
 *     resolved with `includeDeleted: true`, so the rows it passes here are ALREADY soft-deleted.
 *
 * The regression these cases exist to catch is silent. If `hardDelete` ever stops reaching the
 * plugin (`softDeletePlugin` in `db-core/src/utils/mongo.ts`), the fallback soft-deletes instead and
 * returns null, so the boolean goes false - but `findById` applies the plugin's `deletedAt: null`
 * filter and reports the surviving row as gone, and the purge answers `verified: true` over a live
 * document. Whether a row survived is therefore always read here through `FabFile.collection` (the
 * raw driver); a model query is only ever asserted on to show that it CANNOT tell the two apart.
 */
describe('FabFileRepository.hardDeleteOneById', () => {
  setupMongoTest();

  const makeFile = () =>
    FabFile.create({
      userId: 'u-purge-owner',
      fileName: 'doc.txt',
      filePath: 'doc.txt',
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      fileSize: 100,
      status: 'complete',
    });

  it('removes the row, as the raw collection sees it', async () => {
    const file = await makeFile();

    await expect(fabFileRepository.hardDeleteOneById(file._id.toString())).resolves.toBe(true);

    expect(await FabFile.collection.findOne({ _id: file._id })).toBeNull();
  });

  it('a plain findOneAndDelete soft-deletes instead, and only the raw read can tell', async () => {
    // The failure mode itself, pinned so the assertion above is provably discriminating: without
    // `hardDelete` the row survives with a `deletedAt` stamp, yet `findById` - the read the purge
    // verifies with - still reports it gone. If this ever starts behaving like a real delete, the
    // raw-collection assertions in this file have stopped proving anything.
    const file = await makeFile();

    await FabFile.findOneAndDelete({ _id: file._id });

    const survivor = await FabFile.collection.findOne({ _id: file._id });
    expect(survivor?.deletedAt).toBeInstanceOf(Date);
    expect(await FabFile.findById(file._id)).toBeNull();
  });

  it('hard-deletes a row that is already soft-deleted', async () => {
    // What `cleanupDeletedDataLake`'s phase-2 sweep passes in: ids resolved with `includeDeleted`
    // off the rows phase 1 soft-deleted. A filter that hid those would leave the whole lake behind.
    const file = await makeFile();
    await FabFile.updateOne({ _id: file._id }, { $set: { deletedAt: new Date() } });

    await expect(fabFileRepository.hardDeleteOneById(file._id.toString())).resolves.toBe(true);

    expect(await FabFile.collection.findOne({ _id: file._id })).toBeNull();
  });

  it('tells exactly one of two concurrent callers that it did the deleting', async () => {
    // The claim the quota refund rests on: both purges find the gates open and both see the
    // object-store delete succeed, so the boolean is the only thing stopping a double refund.
    const file = await makeFile();

    const results = await Promise.all([
      fabFileRepository.hardDeleteOneById(file._id.toString()),
      fabFileRepository.hardDeleteOneById(file._id.toString()),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await FabFile.collection.findOne({ _id: file._id })).toBeNull();
  });
});
