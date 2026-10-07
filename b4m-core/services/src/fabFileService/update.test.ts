import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { FAB_FILE_CONTENT_REWRITE_PATCH, IFabFileDocument, IUserDocument } from '@bike4mind/common';
import { updateFabFile } from './update';

describe('updateFabFile (upload moderation gate)', () => {
  const mockUser = { id: 'user-123' } as IUserDocument;

  let findUpdateAccessById: Mock;
  let dbUpdate: Mock;
  let mockAdapters: {
    db: { fabFiles: { shareable: { findUpdateAccessById: Mock }; update: Mock } };
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
    findUpdateAccessById = vi.fn();
    dbUpdate = vi.fn().mockResolvedValue(undefined);

    mockAdapters = {
      db: {
        fabFiles: {
          shareable: { findUpdateAccessById },
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
    findUpdateAccessById.mockResolvedValue(baseFile({ moderationStatus: 'pending' }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await updateFabFile(mockUser, { id: 'file-1', notes: 'a note' }, mockAdapters as any);

    expect(result.fileUrl).toBeUndefined();
    expect(result.fileUrlExpireAt).toBeUndefined();
    // Metadata is preserved so the client can still render a "Scanning..." placeholder.
    expect(result.fileName).toBe('photo.png');
    expect(result.notes).toBe('a note');
  });

  it('persists the cleared fileUrl (not the stale one) — clear must happen BEFORE the write', async () => {
    findUpdateAccessById.mockResolvedValue(baseFile({ moderationStatus: 'pending' }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await updateFabFile(mockUser, { id: 'file-1', notes: 'a note' }, mockAdapters as any);

    // Assert on what was actually PERSISTED, not just what was returned - a prior bug
    // cleared the returned object but wrote the stale fileUrl to the DB first, so a
    // subsequent read would resurrect a working URL for a non-serveable image.
    expect(dbUpdate).toHaveBeenCalledOnce();
    const [persisted, options] = dbUpdate.mock.calls[0];
    expect(persisted).toEqual({
      id: 'file-1',
      notes: 'a note',
      systemPriority: undefined,
      updatedAt: expect.any(Date),
    });
    // A `$set` of undefined is dropped by Mongoose, so the clear has to travel as an explicit unset.
    expect(options).toEqual({ unset: ['fileUrl', 'fileUrlExpireAt'] });
  });

  it('strips fileUrl/fileUrlExpireAt on an edit for a blocked image', async () => {
    findUpdateAccessById.mockResolvedValue(baseFile({ moderationStatus: 'blocked' }));

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
    findUpdateAccessById.mockResolvedValue(baseFile({ moderationStatus: 'clean' }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await updateFabFile(mockUser, { id: 'file-1', notes: 'ok' }, mockAdapters as any);

    expect(result.fileUrl).toBe('https://s3.example.com/stale-signed-url');
    expect(result.fileUrlExpireAt).toBeInstanceOf(Date);
    expect(dbUpdate.mock.calls[0][1]).toBeUndefined();
  });

  // isImageServeable now gates on moderationStatus alone (no mimeType special-case):
  // a non-image that hasn't cleared moderation is held identically to an image, since
  // the declared mimeType is client-controlled and only corrected by the async scan.
  it('strips fileUrl on an edit for a non-image file that has not cleared moderation (pending)', async () => {
    findUpdateAccessById.mockResolvedValue(
      baseFile({ mimeType: 'text/plain', fileName: 'notes.txt', moderationStatus: 'pending' })
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await updateFabFile(mockUser, { id: 'file-1', notes: 'ok' }, mockAdapters as any);

    expect(result.fileUrl).toBeUndefined();
    expect(result.fileUrlExpireAt).toBeUndefined();
  });

  it('keeps fileUrl on an edit for a non-image file once moderationStatus is clean', async () => {
    findUpdateAccessById.mockResolvedValue(
      baseFile({ mimeType: 'text/plain', fileName: 'notes.txt', moderationStatus: 'clean' })
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await updateFabFile(mockUser, { id: 'file-1', notes: 'ok' }, mockAdapters as any);

    expect(result.fileUrl).toBe('https://s3.example.com/stale-signed-url');
  });

  // A whole-array write cannot distinguish an intentional lake-leave from a stale client's copy,
  // so the meta-tag is force-carried back into the persisted (and returned) array rather than
  // clearing membership - the response IS the true persisted state, no separate re-read needed.
  it('preserves lake membership when the caller drops the meta-tag but keeps the folder tag', async () => {
    const inLake = baseFile({
      mimeType: 'text/plain',
      fileName: 'notes.txt',
      moderationStatus: 'clean',
      tags: [
        { name: 'datalake:qa-lake', strength: 1 },
        { name: 'qa:invoices', strength: 1 },
      ],
    } as Partial<IFabFileDocument>);
    findUpdateAccessById.mockResolvedValue(inLake);

    const lake = {
      id: 'lake1',
      datalakeTag: 'datalake:qa-lake',
      fileTagPrefix: 'qa:',
      createdByUserId: 'user-123',
      status: 'active',
    };

    const adapters = {
      db: {
        fabFiles: {
          shareable: { findUpdateAccessById },
          update: dbUpdate,
          findById: vi.fn().mockResolvedValue(inLake),
          pullTagsByFabFileId: vi.fn().mockResolvedValue(1),
          computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 0, totalSizeBytes: 0, totalChunkedChars: 0 }),
        },
        dataLakes: { findByDatalakeTag: vi.fn().mockResolvedValue(lake), setStats: vi.fn(), activateIfDraft: vi.fn() },
      },
      storage: mockAdapters.storage,
    };

    // The caller drops the meta-tag but asks to keep the folder tag.
    const result = await updateFabFile(
      mockUser,
      { id: 'file-1', tags: [{ name: 'qa:invoices', strength: 1 }] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adapters as any
    );

    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
    expect(adapters.db.dataLakes.setStats).not.toHaveBeenCalled();
    expect(result.tags).toEqual(
      expect.arrayContaining([
        { name: 'qa:invoices', strength: 1 },
        { name: 'datalake:qa-lake', strength: 1 },
      ])
    );
  });
});

// The lake-tag reconciliation itself (joins, leaves, casing, the fallback content-tag backfill)
// is `reconcileLakeTags`'s own contract and is tested exhaustively in reconcileLakeTags.test.ts.
// These pin only that updateFabFile WIRES it in correctly: skipped on an omitted `tags` field,
// triggered by an explicit `[]`, and its recommendation reaching the persisted document.
describe('updateFabFile (lake-tag reconciliation wiring)', () => {
  const mockUser = { id: 'user-123' } as IUserDocument;

  let findUpdateAccessById: Mock;
  let dbUpdate: Mock;
  let findByDatalakeTag: Mock;
  let mockAdapters: {
    db: {
      fabFiles: {
        shareable: { findUpdateAccessById: Mock };
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
    findUpdateAccessById = vi.fn();
    dbUpdate = vi.fn().mockResolvedValue(undefined);
    findByDatalakeTag = vi.fn().mockResolvedValue(null);

    mockAdapters = {
      db: {
        fabFiles: {
          shareable: { findUpdateAccessById },
          update: dbUpdate,
          findById: vi.fn().mockResolvedValue(null),
          pullTagsByFabFileId: vi.fn().mockResolvedValue(1),
          computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 0, totalSizeBytes: 0, totalChunkedChars: 0 }),
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
    findUpdateAccessById.mockResolvedValue(baseFile({ tags: [{ name: 'design', strength: 1 }] }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await updateFabFile(mockUser, { id: 'file-1', fileName: 'renamed.png' }, mockAdapters as any);

    expect(findByDatalakeTag).not.toHaveBeenCalled();
    // Untouched tags array proves the rename never routed through the reconciler.
    expect(result.tags).toEqual([{ name: 'design', strength: 1 }]);
  });

  it('preserves membership when tags: [] is passed explicitly (a real replacement, not an omission)', async () => {
    const lake = {
      id: 'lake1',
      datalakeTag: 'datalake:acme',
      fileTagPrefix: 'acme:',
      createdByUserId: 'user-123',
      status: 'active',
    };
    findUpdateAccessById.mockResolvedValue(baseFile({ tags: [{ name: 'datalake:acme', strength: 1 }] }));
    findByDatalakeTag.mockResolvedValue(lake);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await updateFabFile(mockUser, { id: 'file-1', tags: [] }, mockAdapters as any);

    // An explicit [] still requires resolving the lake (to confirm membership stands), which an
    // omitted `tags` field never would - but a whole-array write can never leave a lake, so the
    // meta-tag is force-carried back and the fallback tagger backfills a folder stamp for it.
    expect(findByDatalakeTag).toHaveBeenCalledWith('datalake:acme');
    expect(mockAdapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
    expect(result.tags).toEqual(
      expect.arrayContaining([
        { name: 'datalake:acme', strength: 1 },
        { name: 'acme:uncategorized', strength: 1 },
      ])
    );
  });

  it('persists a backfilled content tag from a join, proving the fallback tagger is wired through', async () => {
    const lake = {
      id: 'lake1',
      datalakeTag: 'datalake:acme',
      fileTagPrefix: 'acme:',
      createdByUserId: 'user-123',
      status: 'active',
    };
    findUpdateAccessById.mockResolvedValue(baseFile({ tags: [] }));
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

describe('updateFabFile (narrowed write pins)', () => {
  const NOW = new Date('2026-01-01T00:00:00Z');
  const mockUser = { id: 'user-123' } as IUserDocument;

  let findUpdateAccessById: Mock;
  let dbUpdate: Mock;
  let mockAdapters: {
    db: {
      fabFiles: {
        shareable: { findUpdateAccessById: Mock };
        update: Mock;
        findById: Mock;
        pullTagsByFabFileId: Mock;
        computeDataLakeStats: Mock;
      };
      dataLakes: { findByDatalakeTag: Mock; find: Mock; setStats: Mock; activateIfDraft: Mock };
    };
    storage: { upload: Mock; generateSignedUrl: Mock; getMetadata?: Mock };
  };

  const textFile = (overrides: Partial<IFabFileDocument> = {}): IFabFileDocument =>
    ({
      id: 'file-1',
      userId: 'user-123',
      fileName: 'notes.txt',
      mimeType: 'text/plain',
      filePath: 'uploads/notes.txt',
      moderationStatus: 'clean',
      tags: [],
      fileUrl: 'https://s3.example.com/stale-signed-url',
      users: [],
      groups: [],
      ...overrides,
    }) as IFabFileDocument;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    findUpdateAccessById = vi.fn();
    dbUpdate = vi.fn().mockResolvedValue(undefined);
    mockAdapters = {
      db: {
        fabFiles: {
          shareable: { findUpdateAccessById },
          update: dbUpdate,
          findById: vi.fn().mockResolvedValue(null),
          pullTagsByFabFileId: vi.fn().mockResolvedValue(1),
          computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 0, totalSizeBytes: 0, totalChunkedChars: 0 }),
        },
        dataLakes: {
          findByDatalakeTag: vi.fn().mockResolvedValue(null),
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes only the changed fields and no unset option for a serveable file (notes)', async () => {
    findUpdateAccessById.mockResolvedValue(textFile());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await updateFabFile(mockUser, { id: 'file-1', notes: 'a note' }, mockAdapters as any);

    expect(dbUpdate).toHaveBeenCalledTimes(1);
    expect(dbUpdate.mock.calls[0]).toStrictEqual([
      { id: 'file-1', notes: 'a note', systemPriority: undefined, updatedAt: NOW },
      undefined,
    ]);
  });

  it('writes the reconciled tags array and no other file fields when tags change', async () => {
    findUpdateAccessById.mockResolvedValue(textFile());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await updateFabFile(mockUser, { id: 'file-1', tags: [{ name: 'design', strength: 1 }] }, mockAdapters as any);

    expect(dbUpdate).toHaveBeenCalledTimes(1);
    expect(dbUpdate.mock.calls[0]).toStrictEqual([
      {
        id: 'file-1',
        tags: [{ name: 'design', strength: 1 }],
        systemPriority: undefined,
        updatedAt: NOW,
      },
      undefined,
    ]);
  });

  it('writes the lake meta-tag and backfilled folder tag in the persisted array on a join', async () => {
    mockAdapters.db.dataLakes.findByDatalakeTag.mockResolvedValue({
      id: 'lake1',
      datalakeTag: 'datalake:acme',
      fileTagPrefix: 'acme:',
      createdByUserId: 'user-123',
      status: 'active',
    });
    findUpdateAccessById.mockResolvedValue(textFile());

    await updateFabFile(
      mockUser,
      { id: 'file-1', tags: [{ name: 'datalake:acme', strength: 1 }] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockAdapters as any
    );

    expect(dbUpdate).toHaveBeenCalledTimes(1);
    expect(dbUpdate.mock.calls[0]).toStrictEqual([
      {
        id: 'file-1',
        tags: [
          { name: 'datalake:acme', strength: 1 },
          { name: 'acme:uncategorized', strength: 1 },
        ],
        systemPriority: undefined,
        updatedAt: NOW,
      },
      undefined,
    ]);
  });

  it('defaults systemPriority to 999 when system is set without one', async () => {
    findUpdateAccessById.mockResolvedValue(textFile());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await updateFabFile(mockUser, { id: 'file-1', system: true }, mockAdapters as any);

    expect(dbUpdate.mock.calls[0]).toStrictEqual([
      { id: 'file-1', system: true, systemPriority: 999, updatedAt: NOW },
      undefined,
    ]);
  });

  it('writes the content-rewrite patch with the new url when fileContent changes', async () => {
    findUpdateAccessById.mockResolvedValue(textFile());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await updateFabFile(mockUser, { id: 'file-1', fileContent: 'new body' }, mockAdapters as any);

    expect(dbUpdate).toHaveBeenCalledTimes(1);
    expect(dbUpdate.mock.calls[0]).toStrictEqual([
      {
        id: 'file-1',
        fileUrl: 'https://s3.example.com/new-signed-url',
        fileUrlExpireAt: new Date('2026-01-01T01:00:00Z'),
        ...FAB_FILE_CONTENT_REWRITE_PATCH,
        systemPriority: undefined,
        updatedAt: NOW,
      },
      undefined,
    ]);
  });

  it('writes the stored size alongside the rewrite patch when storage reports metadata', async () => {
    mockAdapters.storage.getMetadata = vi.fn().mockResolvedValue({ size: 8 });
    findUpdateAccessById.mockResolvedValue(textFile());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await updateFabFile(mockUser, { id: 'file-1', fileContent: 'new body' }, mockAdapters as any);

    expect(dbUpdate).toHaveBeenCalledTimes(1);
    expect(dbUpdate.mock.calls[0]).toStrictEqual([
      {
        id: 'file-1',
        fileSize: 8,
        fileUrl: 'https://s3.example.com/new-signed-url',
        fileUrlExpireAt: new Date('2026-01-01T01:00:00Z'),
        ...FAB_FILE_CONTENT_REWRITE_PATCH,
        systemPriority: undefined,
        updatedAt: NOW,
      },
      undefined,
    ]);
  });

  it('sends the unset option, and no url fields in the partial, for a file held by moderation', async () => {
    findUpdateAccessById.mockResolvedValue(textFile({ moderationStatus: 'pending' }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await updateFabFile(mockUser, { id: 'file-1', fileName: 'renamed.txt' }, mockAdapters as any);

    expect(dbUpdate).toHaveBeenCalledTimes(1);
    expect(dbUpdate.mock.calls[0]).toStrictEqual([
      { id: 'file-1', fileName: 'renamed.txt', systemPriority: undefined, updatedAt: NOW },
      { unset: ['fileUrl', 'fileUrlExpireAt'] },
    ]);
  });
});
