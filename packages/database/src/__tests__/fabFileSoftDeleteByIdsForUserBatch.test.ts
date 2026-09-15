import { describe, it, expect, vi } from 'vitest';
import { FabFile, fabFileRepository } from '../models/content/FabFileModel';
import { setupMongoTest } from '../__test__/utils';
import { KnowledgeType } from '@bike4mind/common';

/**
 * Real Mongo: this method's three-clause filter IS the security guard for the upload-complete
 * cleanup (#2090). The per-id loop it replaced enforced owner+batch in application code with two
 * queries per id; collapsing that into one `updateMany` only stays safe if the filter refuses
 * exactly what the loop refused, so that is what these assert rather than the happy path alone.
 */
setupMongoTest();

describe('FabFileRepository.softDeleteByIdsForUserBatch', () => {
  const userId = 'batch-cleanup-owner';
  const batchId = 'batch-1';

  const seed = async (over: Partial<{ userId: string; batchId: string; deletedAt: Date }> = {}) => {
    const doc = await FabFile.create({
      userId: over.userId ?? userId,
      batchId: over.batchId ?? batchId,
      fileName: 'orphan.txt',
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
      ...(over.deletedAt ? { deletedAt: over.deletedAt } : {}),
    });
    return doc.id as string;
  };

  const rawStatus = async (id: string) => {
    const doc = await FabFile.findById(id).setOptions({ includeDeleted: true });
    return doc?.deletedAt ?? null;
  };

  it("soft-deletes the caller's own files stamped with this batch", async () => {
    const a = await seed();
    const b = await seed();

    const count = await fabFileRepository.softDeleteByIdsForUserBatch([a, b], userId, batchId);

    expect(count).toBe(2);
    expect(await rawStatus(a)).toBeInstanceOf(Date);
    expect(await rawStatus(b)).toBeInstanceOf(Date);
  });

  it('refuses a file owned by someone else, even when the id is supplied explicitly', async () => {
    // The stray-id case: a stale or retried client must not be able to delete another user's file.
    const theirs = await seed({ userId: 'a-different-user' });

    const count = await fabFileRepository.softDeleteByIdsForUserBatch([theirs], userId, batchId);

    expect(count).toBe(0);
    expect(await rawStatus(theirs)).toBeNull();
  });

  it("refuses the caller's own file when it belongs to a different batch", async () => {
    // Owned, but not part of this upload - deleting it would destroy unrelated work the user kept.
    const otherBatch = await seed({ batchId: 'some-other-batch' });

    const count = await fabFileRepository.softDeleteByIdsForUserBatch([otherBatch], userId, batchId);

    expect(count).toBe(0);
    expect(await rawStatus(otherBatch)).toBeNull();
  });

  it('deletes only the in-scope ids when a mixed list is supplied', async () => {
    // One updateMany, so a single out-of-scope id must not take the whole call down OR ride along.
    const mine = await seed();
    const theirs = await seed({ userId: 'a-different-user' });
    const otherBatch = await seed({ batchId: 'some-other-batch' });

    const count = await fabFileRepository.softDeleteByIdsForUserBatch([mine, theirs, otherBatch], userId, batchId);

    expect(count).toBe(1);
    expect(await rawStatus(mine)).toBeInstanceOf(Date);
    expect(await rawStatus(theirs)).toBeNull();
    expect(await rawStatus(otherBatch)).toBeNull();
  });

  it('is idempotent, so a client retry does not restamp an already-deleted row', async () => {
    const already = new Date('2026-01-01T00:00:00.000Z');
    const id = await seed({ deletedAt: already });

    const count = await fabFileRepository.softDeleteByIdsForUserBatch([id], userId, batchId);

    expect(count).toBe(0);
    expect(await rawStatus(id)).toEqual(already);
  });

  it('short-circuits an empty list without a write', async () => {
    // Asserting the 0 alone would not detect the guard's removal: `$in: []` matches nothing, so
    // modifiedCount is 0 either way. The point of the guard is that no query is issued at all.
    const updateMany = vi.spyOn(FabFile, 'updateMany');

    expect(await fabFileRepository.softDeleteByIdsForUserBatch([], userId, batchId)).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();

    updateMany.mockRestore();
  });
});
