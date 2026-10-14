import { describe, it, expect, vi } from 'vitest';
import { BadRequestError, NotFoundError, STORAGE_CHARGE_STAMP_CUTOFF, type IUserDocument } from '@bike4mind/common';
import { assertRewriteFits, commitContentRewrite } from './rewriteStorage';

const MB = 1_000_000;
const owner = (currentStorageSize: number) =>
  ({ id: 'owner', storageLimit: 1, currentStorageSize }) as unknown as IUserDocument;

type Pre = { userId: string; fileSize?: number; storageChargedAt?: Date; status?: string; createdAt?: Date };
const makeDb = (pre: Pre | null = null) => ({
  fabFiles: { commitContentRewrite: vi.fn().mockResolvedValue(pre) },
  users: { findById: vi.fn(), incrementCurrentStorage: vi.fn() },
});

const before = new Date('2026-01-01T00:00:00Z');
// Charged by the S3 handler before it stamped anything (see isStorageCharged in @bike4mind/common).
const legacy = { status: 'complete', createdAt: new Date(STORAGE_CHARGE_STAMP_CUTOFF.getTime() - 1) };
const unchargedNew = { status: 'complete', createdAt: new Date(STORAGE_CHARGE_STAMP_CUTOFF.getTime() + 1) };

describe('commitContentRewrite', () => {
  it.each([
    ['growth', 100, 150, 50],
    ['shrink', 100, 40, -60],
  ])('moves the owner by the delta on %s', async (_label, oldSize, newSize, delta) => {
    const db = makeDb({ userId: 'owner', fileSize: oldSize, storageChargedAt: before });

    expect(await commitContentRewrite({ fabFileId: 'f1', newSize, set: { a: 1 } }, db)).toBe(true);

    expect(db.fabFiles.commitContentRewrite).toHaveBeenCalledWith('f1', { a: 1, fileSize: newSize }, undefined);
    expect(db.users.incrementCurrentStorage).toHaveBeenCalledWith('owner', delta);
  });

  it('writes nothing to the counter on a same-size rewrite', async () => {
    const db = makeDb({ userId: 'owner', fileSize: 100, storageChargedAt: before });
    await commitContentRewrite({ fabFileId: 'f1', newSize: 100 }, db);
    expect(db.users.incrementCurrentStorage).not.toHaveBeenCalled();
  });

  it('charges the full new size when the old bytes were never charged', async () => {
    const db = makeDb({ userId: 'owner', fileSize: 100, ...unchargedNew });
    await commitContentRewrite({ fabFileId: 'f1', newSize: 70 }, db);
    expect(db.users.incrementCurrentStorage).toHaveBeenCalledWith('owner', 70);
  });

  it('moves a legacy unstamped row by the delta, not the full new size', async () => {
    const db = makeDb({ userId: 'owner', fileSize: 5000, ...legacy });
    await commitContentRewrite({ fabFileId: 'f1', newSize: 5100 }, db);
    expect(db.users.incrementCurrentStorage).toHaveBeenCalledWith('owner', 100);
  });

  it('charges nothing more when the S3 event already claimed this upload', async () => {
    // The claim wrote the new size and charged the difference; the commit sees it in the pre-image.
    const db = makeDb({ userId: 'owner', fileSize: 150, storageChargedAt: new Date() });
    await commitContentRewrite({ fabFileId: 'f1', newSize: 150 }, db);
    expect(db.users.incrementCurrentStorage).not.toHaveBeenCalled();
  });

  it('keeps the counter at the truth when two rewrites of one file overlap', async () => {
    // A row store that applies commits the way the repository does: atomic set, pre-image returned.
    let row: Pre = { userId: 'owner', fileSize: 1000, storageChargedAt: before };
    let counter = 1000;
    const db = {
      fabFiles: {
        commitContentRewrite: vi.fn(async (_id: string, set: Record<string, unknown>) => {
          const pre = row;
          row = { ...row, ...set, storageChargedAt: new Date() };
          return pre;
        }),
      },
      users: {
        findById: vi.fn(),
        incrementCurrentStorage: vi.fn(async (_id: string, d: number) => void (counter += d)),
      },
    };

    // B read the row before A committed and commits after it; neither S3 event claims (stamps are newer).
    await commitContentRewrite({ fabFileId: 'f1', newSize: 2000 }, db);
    await commitContentRewrite({ fabFileId: 'f1', newSize: 3000 }, db);

    expect(row.fileSize).toBe(3000);
    expect(counter).toBe(3000);
  });

  it('leaves the counter alone when the filter missed', async () => {
    const db = makeDb(null);
    const committed = await commitContentRewrite({ fabFileId: 'f1', newSize: 150, filter: { filePath: 'old' } }, db);
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

  it('never refuses a shrink of a legacy unstamped row near the quota', async () => {
    const legacyRow = { userId: 'owner', fileSize: 5 * MB, ...legacy };
    const ownerAt = { id: 'owner', storageLimit: 10, currentStorageSize: 9.9 * MB } as unknown as IUserDocument;
    await expect(assertRewriteFits(legacyRow, 4 * MB, makeDb(), ownerAt)).resolves.toBeUndefined();
  });

  it('throws NotFoundError when the owner of a growing file is gone', async () => {
    const db = makeDb();
    db.users.findById.mockResolvedValue(null);
    const editor = { id: 'editor', storageLimit: 1000, currentStorageSize: 0 } as unknown as IUserDocument;

    await expect(assertRewriteFits(row, 1.2 * MB, db, editor)).rejects.toThrow(NotFoundError);
  });

  it('measures against the owner, not an update-share editor', async () => {
    const db = makeDb();
    db.users.findById.mockResolvedValue(owner(0.9 * MB));
    const editor = { id: 'editor', storageLimit: 1000, currentStorageSize: 0 } as unknown as IUserDocument;

    await expect(assertRewriteFits(row, 1.2 * MB, db, editor)).rejects.toThrow('File size exceeds storage limit');
    expect(db.users.findById).toHaveBeenCalledWith('owner');
  });
});
