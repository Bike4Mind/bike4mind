import { describe, it, expect, vi } from 'vitest';
import { BadRequestError, type IUserDocument } from '@bike4mind/common';
import { assertRewriteFits, chargedBytes, commitContentRewrite } from './rewriteStorage';

const MB = 1_000_000;
const owner = (currentStorageSize: number) =>
  ({ id: 'owner', storageLimit: 1, currentStorageSize }) as unknown as IUserDocument;

const makeDb = (pre: { userId: string; fileSize?: number; storageChargedAt?: Date } | null = null) => ({
  fabFiles: { commitContentRewrite: vi.fn().mockResolvedValue(pre) },
  users: { findById: vi.fn(), incrementCurrentStorage: vi.fn() },
});

const uploadStartedAt = new Date('2026-01-01T00:00:10Z');
const before = new Date('2026-01-01T00:00:00Z');

describe('chargedBytes', () => {
  it('counts nothing for a row nothing charged', () => {
    expect(chargedBytes({ fileSize: 50 })).toBe(0);
    expect(chargedBytes({ fileSize: 50, storageChargedAt: before })).toBe(50);
  });
});

describe('commitContentRewrite', () => {
  it.each([
    ['growth', 100, 150, 50],
    ['shrink', 100, 40, -60],
  ])('moves the owner by the delta on %s', async (_label, oldSize, newSize, delta) => {
    const db = makeDb({ userId: 'owner', fileSize: oldSize, storageChargedAt: before });

    expect(await commitContentRewrite({ fabFileId: 'f1', newSize, uploadStartedAt, set: { a: 1 } }, db)).toBe(true);

    expect(db.fabFiles.commitContentRewrite).toHaveBeenCalledWith('f1', { a: 1, fileSize: newSize }, undefined);
    expect(db.users.incrementCurrentStorage).toHaveBeenCalledWith('owner', delta);
  });

  it('writes nothing to the counter on a same-size rewrite', async () => {
    const db = makeDb({ userId: 'owner', fileSize: 100, storageChargedAt: before });
    await commitContentRewrite({ fabFileId: 'f1', newSize: 100, uploadStartedAt }, db);
    expect(db.users.incrementCurrentStorage).not.toHaveBeenCalled();
  });

  it('charges the full new size when the old bytes were never charged', async () => {
    const db = makeDb({ userId: 'owner', fileSize: 100 });
    await commitContentRewrite({ fabFileId: 'f1', newSize: 70, uploadStartedAt }, db);
    expect(db.users.incrementCurrentStorage).toHaveBeenCalledWith('owner', 70);
  });

  it('only refunds the old bytes when the S3 event already charged this upload', async () => {
    const eventStamp = new Date(uploadStartedAt.getTime() + 500);
    // The event's claim moved the stamp but not fileSize: the pre-image still holds the old size.
    const db = makeDb({ userId: 'owner', fileSize: 100, storageChargedAt: eventStamp });
    await commitContentRewrite({ fabFileId: 'f1', newSize: 150, uploadStartedAt }, db);
    expect(db.users.incrementCurrentStorage).toHaveBeenCalledWith('owner', -100);
  });

  it('leaves the counter alone when the filter missed', async () => {
    const db = makeDb(null);
    const committed = await commitContentRewrite(
      { fabFileId: 'f1', newSize: 150, uploadStartedAt, filter: { filePath: 'old' } },
      db
    );
    expect(committed).toBe(false);
    expect(db.fabFiles.commitContentRewrite).toHaveBeenCalledWith('f1', { fileSize: 150 }, { filePath: 'old' });
    expect(db.users.incrementCurrentStorage).not.toHaveBeenCalled();
  });
});

describe('assertRewriteFits', () => {
  const row = { userId: 'owner', fileSize: 0.5 * MB, storageChargedAt: before };

  it('refuses growth past the quota', async () => {
    const db = makeDb();
    await expect(assertRewriteFits(row, 1.2 * MB, db, owner(0.9 * MB))).rejects.toThrow(BadRequestError);
    await expect(assertRewriteFits(row, 1.2 * MB, db, owner(0.9 * MB))).rejects.toThrow(
      'File size exceeds storage limit'
    );
  });

  it('measures only the growth, not the whole new size', async () => {
    await expect(assertRewriteFits(row, 0.6 * MB, makeDb(), owner(0.9 * MB))).resolves.toBeUndefined();
  });

  it('never refuses a shrink, even over quota', async () => {
    await expect(assertRewriteFits(row, 0.1 * MB, makeDb(), owner(5 * MB))).resolves.toBeUndefined();
  });

  it('measures against the owner, not an update-share editor', async () => {
    const db = makeDb();
    db.users.findById.mockResolvedValue(owner(0.9 * MB));
    const editor = { id: 'editor', storageLimit: 1000, currentStorageSize: 0 } as unknown as IUserDocument;

    await expect(assertRewriteFits(row, 1.2 * MB, db, editor)).rejects.toThrow('File size exceeds storage limit');
    expect(db.users.findById).toHaveBeenCalledWith('owner');
  });
});
