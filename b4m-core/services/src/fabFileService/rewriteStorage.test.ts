import { describe, it, expect, vi } from 'vitest';
import {
  BadRequestError,
  NotFoundError,
  STORAGE_CHARGE_STAMP_CUTOFF,
  StorageLimitError,
  type IUserDocument,
} from '@bike4mind/common';
import { assertRewriteFits, commitContentRewrite } from './rewriteStorage';

const MB = 1_000_000;
const owner = (currentStorageSize: number) =>
  ({ id: 'owner', storageLimit: 1, currentStorageSize }) as unknown as IUserDocument;

type Pre = {
  userId: string;
  organizationId?: string;
  fileSize?: number;
  storageChargedAt?: Date;
  status?: string;
  createdAt?: Date;
};
const makeDb = (pre: Pre | null = null, stored: Pre | null = pre) => ({
  fabFiles: {
    commitContentRewrite: vi.fn().mockResolvedValue(pre),
    findChargeState: vi.fn().mockResolvedValue(stored),
  },
  users: { findById: vi.fn(), incrementCurrentStorage: vi.fn() },
  organizations: { findById: vi.fn(), incrementCurrentStorage: vi.fn() },
});

const before = new Date('2026-01-01T00:00:00Z');
// Charged by the S3 handler before it stamped anything (see isStorageCharged in @bike4mind/common).
const legacy = { status: 'complete', createdAt: new Date(STORAGE_CHARGE_STAMP_CUTOFF.getTime() - 1) };
// Predates the status field: no `status` key at all.
const legacyNoStatus = { createdAt: new Date(STORAGE_CHARGE_STAMP_CUTOFF.getTime() - 1) };
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

  it('charges a legacy row with no status the full new size, since it reads as never charged', async () => {
    const db = makeDb({ userId: 'owner', fileSize: 1000, ...legacyNoStatus });
    await commitContentRewrite({ fabFileId: 'f1', newSize: 1000 }, db);
    expect(db.users.incrementCurrentStorage).toHaveBeenCalledWith('owner', 1000);
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
        findChargeState: vi.fn(),
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

  it('moves the owning org counter, not the uploader, for an org-stamped row', async () => {
    const db = makeDb({ userId: 'owner', organizationId: 'org-1', fileSize: 100, storageChargedAt: before });

    await commitContentRewrite({ fabFileId: 'f1', newSize: 150 }, db);

    expect(db.organizations.incrementCurrentStorage).toHaveBeenCalledWith('org-1', 50);
    expect(db.users.incrementCurrentStorage).not.toHaveBeenCalled();
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
  const stored = { userId: 'owner', fileSize: 0.5 * MB, storageChargedAt: before };
  const row = { id: 'f1' };

  it('refuses growth past the quota', async () => {
    const db = makeDb(null, stored);
    await expect(assertRewriteFits(row, 1.2 * MB, db, owner(0.9 * MB))).rejects.toThrow(BadRequestError);
    await expect(assertRewriteFits(row, 1.2 * MB, db, owner(0.9 * MB))).rejects.toThrow(
      'File size exceeds storage limit'
    );
  });

  it('measures only the growth, not the whole new size', async () => {
    await expect(assertRewriteFits(row, 0.6 * MB, makeDb(null, stored), owner(0.9 * MB))).resolves.toBeUndefined();
  });

  it('never refuses a shrink, even over quota', async () => {
    await expect(assertRewriteFits(row, 0.1 * MB, makeDb(null, stored), owner(5 * MB))).resolves.toBeUndefined();
  });

  it('never refuses a same-size rewrite, even over quota', async () => {
    await expect(assertRewriteFits(row, 0.5 * MB, makeDb(null, stored), owner(5 * MB))).resolves.toBeUndefined();
  });

  it.each([['complete', legacy]])(
    'never refuses a shrink of a legacy %s unstamped row near the quota',
    async (_label, fields) => {
      const db = makeDb(null, { userId: 'owner', fileSize: 5 * MB, ...fields });
      const ownerAt = { id: 'owner', storageLimit: 10, currentStorageSize: 9.9 * MB } as unknown as IUserDocument;
      await expect(assertRewriteFits(row, 4 * MB, db, ownerAt)).resolves.toBeUndefined();
      expect(db.fabFiles.findChargeState).toHaveBeenCalledWith('f1');
    }
  );

  it('throws NotFoundError when the owner of a growing file is gone', async () => {
    const db = makeDb(null, stored);
    db.users.findById.mockResolvedValue(null);
    const editor = { id: 'editor', storageLimit: 1000, currentStorageSize: 0 } as unknown as IUserDocument;

    await expect(assertRewriteFits(row, 1.2 * MB, db, editor)).rejects.toThrow(NotFoundError);
  });

  it.each([
    ['uploader', 'storage_limit_exceeded', 'user', stored],
    ['org', 'org_storage_limit_exceeded', 'org', { ...stored, organizationId: 'org-1' }],
  ])("redacts the %s pool's refusal for a non-owner actor", async (_label, errorCode, poolOwner, storedRow) => {
    const db = makeDb(null, storedRow);
    db.users.findById.mockResolvedValue(owner(0.9 * MB));
    db.organizations.findById.mockResolvedValue({ id: 'org-1', storageLimit: 1, currentStorageSize: 0.9 * MB });
    const editor = { id: 'editor' } as unknown as IUserDocument;

    const error = await assertRewriteFits(row, 1.2 * MB, db, editor).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StorageLimitError);
    expect((error as StorageLimitError).additionalInfo).toStrictEqual({ errorCode, owner: poolOwner });
  });

  it('measures against the owner, not an update-share editor', async () => {
    const db = makeDb(null, stored);
    db.users.findById.mockResolvedValue(owner(0.9 * MB));
    const editor = { id: 'editor', storageLimit: 1000, currentStorageSize: 0 } as unknown as IUserDocument;

    await expect(assertRewriteFits(row, 1.2 * MB, db, editor)).rejects.toMatchObject({
      info: { errorCode: 'storage_limit_exceeded', owner: 'user' },
    });
    expect(db.users.findById).toHaveBeenCalledWith('owner');
  });

  it('measures an org-stamped row against the org quota, not the uploader', async () => {
    const db = makeDb(null, { ...stored, organizationId: 'org-1' });
    db.organizations.findById.mockResolvedValue({ id: 'org-1', storageLimit: 1, currentStorageSize: 0.9 * MB });

    // The uploader has room; the org does not.
    await expect(assertRewriteFits(row, 1.2 * MB, db, owner(0))).rejects.toMatchObject({
      info: { errorCode: 'org_storage_limit_exceeded', owner: 'org' },
    });
    expect(db.organizations.findById).toHaveBeenCalledWith('org-1');
  });
});
