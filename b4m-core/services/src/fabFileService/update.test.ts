import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { IFabFileDocument, IUserDocument } from '@bike4mind/common';
import { updateFabFile } from './update';

describe('updateFabFile (upload moderation gate)', () => {
  const mockUser = { id: 'user-123' } as IUserDocument;

  let findAccessibleById: Mock;
  let dbUpdate: Mock;
  let mockAdapters: {
    db: { fabFiles: { shareable: { findAccessibleById: Mock }; update: Mock } };
    storage: { upload: Mock; generateSignedUrl: Mock };
  };

  const baseFile = (overrides: Partial<IFabFileDocument> = {}): IFabFileDocument =>
    ({
      id: 'file-1',
      userId: 'user-123',
      fileName: 'photo.png',
      mimeType: 'image/png',
      filePath: 'uploads/photo.png',
      fileSize: 1024,
      fileUrl: 'https://s3.example.com/stale-signed-url',
      fileUrlExpireAt: new Date(Date.now() + 3600000),
      users: [],
      groups: [],
      isGlobalRead: false,
      isGlobalWrite: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }) as IFabFileDocument;

  beforeEach(() => {
    vi.clearAllMocks();
    findAccessibleById = vi.fn();
    dbUpdate = vi.fn().mockResolvedValue(undefined);

    mockAdapters = {
      db: {
        fabFiles: {
          shareable: { findAccessibleById },
          update: dbUpdate,
        },
      },
      storage: {
        upload: vi.fn().mockResolvedValue(undefined),
        generateSignedUrl: vi.fn().mockResolvedValue('https://s3.example.com/new-signed-url'),
      },
    };
  });

  it('strips fileUrl/fileUrlExpireAt on an edit when the image is still pending moderation', async () => {
    findAccessibleById.mockResolvedValue(baseFile({ moderationStatus: 'pending' }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await updateFabFile(mockUser, { id: 'file-1', notes: 'a note' }, mockAdapters as any);

    expect(result.fileUrl).toBeUndefined();
    expect(result.fileUrlExpireAt).toBeUndefined();
    // Metadata is preserved so the client can still render a "Scanning..." placeholder.
    expect(result.fileName).toBe('photo.png');
    expect(result.notes).toBe('a note');
  });

  it('persists the cleared fileUrl (not the stale one) — clear must happen BEFORE the write', async () => {
    findAccessibleById.mockResolvedValue(baseFile({ moderationStatus: 'pending' }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await updateFabFile(mockUser, { id: 'file-1', notes: 'a note' }, mockAdapters as any);

    // Assert on what was actually PERSISTED, not just what was returned - a prior bug
    // cleared the returned object but wrote the stale fileUrl to the DB first, so a
    // subsequent read would resurrect a working URL for a non-serveable image.
    expect(dbUpdate).toHaveBeenCalledOnce();
    const persisted = dbUpdate.mock.calls[0][0];
    expect(persisted.fileUrl).toBeUndefined();
    expect(persisted.fileUrlExpireAt).toBeUndefined();
  });

  it('strips fileUrl/fileUrlExpireAt on an edit for a blocked image', async () => {
    findAccessibleById.mockResolvedValue(baseFile({ moderationStatus: 'blocked' }));

    const result = await updateFabFile(
      mockUser,
      { id: 'file-1', fileName: 'renamed.png' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockAdapters as any
    );

    expect(result.fileUrl).toBeUndefined();
    expect(result.fileUrlExpireAt).toBeUndefined();
    expect(result.fileName).toBe('renamed.png');
  });

  it('keeps fileUrl on an edit for a clean image (unaffected)', async () => {
    findAccessibleById.mockResolvedValue(baseFile({ moderationStatus: 'clean' }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await updateFabFile(mockUser, { id: 'file-1', notes: 'ok' }, mockAdapters as any);

    expect(result.fileUrl).toBe('https://s3.example.com/stale-signed-url');
    expect(result.fileUrlExpireAt).toBeInstanceOf(Date);
  });

  // isImageServeable now gates on moderationStatus alone (no mimeType special-case):
  // a non-image that hasn't cleared moderation is held identically to an image, since
  // the declared mimeType is client-controlled and only corrected by the async scan.
  it('strips fileUrl on an edit for a non-image file that has not cleared moderation (pending)', async () => {
    findAccessibleById.mockResolvedValue(
      baseFile({ mimeType: 'text/plain', fileName: 'notes.txt', moderationStatus: 'pending' })
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await updateFabFile(mockUser, { id: 'file-1', notes: 'ok' }, mockAdapters as any);

    expect(result.fileUrl).toBeUndefined();
    expect(result.fileUrlExpireAt).toBeUndefined();
  });

  it('keeps fileUrl on an edit for a non-image file once moderationStatus is clean', async () => {
    findAccessibleById.mockResolvedValue(
      baseFile({ mimeType: 'text/plain', fileName: 'notes.txt', moderationStatus: 'clean' })
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await updateFabFile(mockUser, { id: 'file-1', notes: 'ok' }, mockAdapters as any);

    expect(result.fileUrl).toBe('https://s3.example.com/stale-signed-url');
  });

  // A leave clears the lake's prefixed content tags AFTER the array write, so the object
  // assembled from the request no longer matches storage. Reported by QA on PR #1128: an API
  // client trusting the response would think tags survived that were already gone.
  it('reports the tags as persisted after a lake leave, not the pre-cleanup array', async () => {
    const inLake = baseFile({
      mimeType: 'text/plain',
      fileName: 'notes.txt',
      moderationStatus: 'clean',
      tags: [
        { name: 'datalake:qa-lake', strength: 1 },
        { name: 'qa:invoices', strength: 1 },
      ],
    } as Partial<IFabFileDocument>);
    findAccessibleById.mockResolvedValue(inLake);

    const lake = {
      id: 'lake1',
      datalakeTag: 'datalake:qa-lake',
      fileTagPrefix: 'qa:',
      createdByUserId: 'user-123',
      status: 'active',
    };
    // First read is removeFileFromLake testing membership; the second is the post-commit re-read.
    const findById = vi
      .fn()
      .mockResolvedValueOnce(inLake)
      .mockResolvedValue({ ...inLake, tags: [] });

    const adapters = {
      db: {
        fabFiles: {
          shareable: { findAccessibleById },
          update: dbUpdate,
          findById,
          pullTagsByFabFileId: vi.fn().mockResolvedValue(1),
          computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 0, totalSizeBytes: 0 }),
        },
        dataLakes: { findByDatalakeTag: vi.fn().mockResolvedValue(lake), setStats: vi.fn(), activateIfDraft: vi.fn() },
      },
      storage: mockAdapters.storage,
    };

    // The caller drops the meta-tag but asks to keep the folder tag; the leave clears both.
    const result = await updateFabFile(
      mockUser,
      { id: 'file-1', tags: [{ name: 'qa:invoices', strength: 1 }] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adapters as any
    );

    expect(adapters.db.fabFiles.pullTagsByFabFileId).toHaveBeenCalledWith('file-1', [
      'datalake:qa-lake',
      'qa:invoices',
    ]);
    expect(result.tags).toEqual([]);
  });
});

// The lake-tag reconciliation itself (joins, leaves, casing, the fallback content-tag backfill)
// is `reconcileLakeTags`'s own contract and is tested exhaustively in reconcileLakeTags.test.ts.
// These pin only that updateFabFile WIRES it in correctly: skipped on an omitted `tags` field,
// triggered by an explicit `[]`, and its recommendation reaching the persisted document.
describe('updateFabFile (lake-tag reconciliation wiring)', () => {
  const mockUser = { id: 'user-123' } as IUserDocument;

  let findAccessibleById: Mock;
  let dbUpdate: Mock;
  let findByDatalakeTag: Mock;
  let mockAdapters: {
    db: {
      fabFiles: {
        shareable: { findAccessibleById: Mock };
        update: Mock;
        findById: Mock;
        pullTagsByFabFileId: Mock;
        computeDataLakeStats: Mock;
      };
      dataLakes: { findByDatalakeTag: Mock; find: Mock; setStats: Mock };
    };
    storage: { upload: Mock; generateSignedUrl: Mock };
  };

  const baseFile = (overrides: Partial<IFabFileDocument> = {}): IFabFileDocument =>
    ({
      id: 'file-1',
      userId: 'user-123',
      fileName: 'photo.png',
      mimeType: 'image/png',
      filePath: 'uploads/photo.png',
      fileSize: 1024,
      moderationStatus: 'clean',
      tags: [],
      users: [],
      groups: [],
      isGlobalRead: false,
      isGlobalWrite: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }) as IFabFileDocument;

  beforeEach(() => {
    vi.clearAllMocks();
    findAccessibleById = vi.fn();
    dbUpdate = vi.fn().mockResolvedValue(undefined);
    findByDatalakeTag = vi.fn().mockResolvedValue(null);

    mockAdapters = {
      db: {
        fabFiles: {
          shareable: { findAccessibleById },
          update: dbUpdate,
          findById: vi.fn().mockResolvedValue(null),
          pullTagsByFabFileId: vi.fn().mockResolvedValue(1),
          computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 0, totalSizeBytes: 0 }),
        },
        dataLakes: {
          findByDatalakeTag,
          find: vi.fn().mockResolvedValue([]),
          setStats: vi.fn(),
          activateIfDraft: vi.fn(),
        },
      },
      storage: {
        upload: vi.fn().mockResolvedValue(undefined),
        generateSignedUrl: vi.fn().mockResolvedValue('https://s3.example.com/new-signed-url'),
      },
    };
  });

  it('does not touch data lakes when tags is omitted (a rename)', async () => {
    findAccessibleById.mockResolvedValue(baseFile({ tags: [{ name: 'design', strength: 1 }] }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await updateFabFile(mockUser, { id: 'file-1', fileName: 'renamed.png' }, mockAdapters as any);

    expect(findByDatalakeTag).not.toHaveBeenCalled();
    // Untouched tags array proves the rename never routed through the reconciler.
    expect(result.tags).toEqual([{ name: 'design', strength: 1 }]);
  });

  it('reconciles when tags: [] is passed explicitly (a real replacement, not an omission)', async () => {
    const lake = {
      id: 'lake1',
      datalakeTag: 'datalake:acme',
      fileTagPrefix: 'acme:',
      createdByUserId: 'user-123',
      status: 'active',
    };
    findAccessibleById.mockResolvedValue(baseFile({ tags: [{ name: 'datalake:acme', strength: 1 }] }));
    findByDatalakeTag.mockResolvedValue(lake);
    // removeFileFromLake's own membership check reads this first (still a member, so the pull
    // fires); the post-commit re-read in update.ts then sees what that pull left behind.
    mockAdapters.db.fabFiles.findById
      .mockResolvedValueOnce({ id: 'file-1', userId: 'user-123', tags: [{ name: 'datalake:acme', strength: 1 }] })
      .mockResolvedValue({ id: 'file-1', userId: 'user-123', tags: [] });
    mockAdapters.db.fabFiles.pullTagsByFabFileId = vi.fn().mockResolvedValue(1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await updateFabFile(mockUser, { id: 'file-1', tags: [] }, mockAdapters as any);

    // An explicit [] reads as leaving every lake the file was in, which requires resolving one -
    // an omitted field never would.
    expect(findByDatalakeTag).toHaveBeenCalledWith('datalake:acme');
    expect(mockAdapters.db.fabFiles.pullTagsByFabFileId).toHaveBeenCalledWith('file-1', ['datalake:acme']);
    expect(result.tags).toEqual([]);
  });

  it('persists a backfilled content tag from a join, proving the fallback tagger is wired through', async () => {
    const lake = {
      id: 'lake1',
      datalakeTag: 'datalake:acme',
      fileTagPrefix: 'acme:',
      createdByUserId: 'user-123',
      status: 'active',
    };
    findAccessibleById.mockResolvedValue(baseFile({ tags: [] }));
    findByDatalakeTag.mockResolvedValue(lake);

    const result = await updateFabFile(
      mockUser,
      { id: 'file-1', tags: [{ name: 'datalake:acme', strength: 1 }] },
      mockAdapters as any
    );

    // The join stamps only the meta-tag; the file has no other tag under the lake's prefix, so
    // the fallback tagger backfills one into the array this door actually persists.
    expect(result.tags).toEqual(
      expect.arrayContaining([
        { name: 'datalake:acme', strength: 1 },
        { name: 'acme:uncategorized', strength: 1 },
      ])
    );
    const persisted = dbUpdate.mock.calls[0][0];
    expect(persisted.tags).toEqual(result.tags);
  });
});
