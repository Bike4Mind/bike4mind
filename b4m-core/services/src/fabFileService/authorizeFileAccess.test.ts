import { describe, it, expect, vi } from 'vitest';
import { NotFoundError } from '@bike4mind/utils';
import { assertFabFileAccessById } from './authorizeFileAccess';
import type { IFabFileDocument, IFabFileRepository, IUserDocument } from '@bike4mind/common';

const userA = { id: 'user-a', groups: [] } as unknown as IUserDocument;

function dbWith(result: unknown) {
  const findAccessibleById = vi.fn().mockResolvedValue(result);
  const db = { fabFiles: { shareable: { findAccessibleById } } } as unknown as {
    fabFiles: Pick<IFabFileRepository, 'shareable'>;
  };
  return { db, findAccessibleById };
}

describe('assertFabFileAccessById', () => {
  it('returns the file when the shareable access predicate grants it', async () => {
    const fabFile = { id: 'f1', userId: 'user-a', fileName: 'mine.txt' } as unknown as IFabFileDocument;
    const { db, findAccessibleById } = dbWith(fabFile);

    await expect(assertFabFileAccessById(userA, 'f1', { db })).resolves.toBe(fabFile);
    expect(findAccessibleById).toHaveBeenCalledWith(userA, 'f1');
  });

  it("throws NotFoundError when the file is missing or is another user's (a probe can't tell which)", async () => {
    // findAccessibleById returns null both when the id does not exist and when it exists but the
    // caller has no owner/share grant - the IDOR guard collapses both to the same 404.
    const { db } = dbWith(null);

    await expect(assertFabFileAccessById(userA, 'someone-elses-id', { db })).rejects.toBeInstanceOf(NotFoundError);
  });
});
