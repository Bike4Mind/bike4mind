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
        dataLakes: { findByDatalakeTag: vi.fn().mockResolvedValue(lake), setStats: vi.fn() },
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
