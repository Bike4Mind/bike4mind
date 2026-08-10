import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { KnowledgeType } from '@bike4mind/common';
import { createFabFile, type CreateFabFileAdapters } from './create';

// Unsupported file-type gating on ingest. The rejection throws right
// after the user lookup - before any settings/storage adapter is touched - so
// these cases only need a user stub. This guards the loophole where a file with
// an unknown extension (e.g. .exe) was silently coerced to text/plain and
// accepted. (Extension-to-MIME resolution itself is covered by utils/file.test.ts.)
function adapters(): CreateFabFileAdapters {
  return {
    // any: these adapters are never reached on the rejection path under test.
    db: {
      users: { findById: vi.fn().mockResolvedValue({ id: 'u1' } as any) },
      fabFiles: { create: vi.fn() },
      adminSettings: { findAll: vi.fn(), findBySettingNames: vi.fn() } as any,
    },
    storage: { generateSignedUrl: vi.fn(), upload: vi.fn() },
  };
}

const base = { fileSize: 100, type: KnowledgeType.FILE as const };

describe('createFabFile — unsupported file-type gating', () => {
  it('rejects a binary with an unknown extension and empty MIME type (the .exe loophole)', async () => {
    await expect(createFabFile('u1', { ...base, fileName: 'malware.exe', mimeType: '' }, adapters())).rejects.toThrow(
      /not supported/i
    );
  });

  it('rejects a binary whose claimed MIME type is a real-but-unsupported type', async () => {
    await expect(
      createFabFile('u1', { ...base, fileName: 'installer.dll', mimeType: 'application/x-msdownload' }, adapters())
    ).rejects.toThrow(/not supported/i);
    await expect(
      createFabFile('u1', { ...base, fileName: 'bundle.zip', mimeType: 'application/octet-stream' }, adapters())
    ).rejects.toThrow(/not supported/i);
  });
});

describe('createFabFile (upload moderation gate root cause)', () => {
  const mockUserId = 'user-123';

  let mockAdapters: CreateFabFileAdapters;
  let fabFilesCreate: Mock;
  let storageUpload: Mock;
  let storageGenerateSignedUrl: Mock;

  beforeEach(() => {
    vi.clearAllMocks();

    fabFilesCreate = vi.fn().mockImplementation(async data => ({ id: 'fab-1', ...data }));
    storageUpload = vi.fn().mockResolvedValue(undefined);
    storageGenerateSignedUrl = vi.fn().mockResolvedValue('https://s3.example.com/signed-url');

    mockAdapters = {
      db: {
        fabFiles: { create: fabFilesCreate },
        adminSettings: {
          findAll: vi.fn().mockResolvedValue([]),
          findBySettingNames: vi.fn().mockResolvedValue([]),
        },
        users: {
          findById: vi.fn().mockResolvedValue({ id: mockUserId, storageLimit: 1000, currentStorageSize: 0 }),
        },
      },
      storage: {
        generateSignedUrl: storageGenerateSignedUrl,
        upload: storageUpload,
      },
    } as unknown as CreateFabFileAdapters;
  });

  it('does NOT mint or persist a fileUrl for an image ingested with content (bytes in hand)', async () => {
    const result = await createFabFile(
      mockUserId,
      {
        fileName: 'photo.png',
        mimeType: 'image/png',
        fileSize: 1024,
        type: KnowledgeType.FILE,
        content: Buffer.from('fake-image-bytes'),
        contentType: 'image/png',
      },
      mockAdapters
    );

    // Bytes are still uploaded to storage - only the servable GET url is withheld.
    expect(storageUpload).toHaveBeenCalled();
    expect(storageGenerateSignedUrl).not.toHaveBeenCalled();

    expect(result.fileUrl).toBeUndefined();
    expect(result.fileUrlExpireAt).toBeUndefined();
    // moderationStatus must be left for the schema default ('pending'), never stamped 'clean' here.
    expect((result as { moderationStatus?: string }).moderationStatus).toBeUndefined();

    const persistedData = fabFilesCreate.mock.calls[0][0];
    expect(persistedData).not.toHaveProperty('fileUrl');
    expect(persistedData).not.toHaveProperty('fileUrlExpireAt');
  });

  it('still mints and persists a fileUrl for non-image content (unaffected)', async () => {
    const result = await createFabFile(
      mockUserId,
      {
        fileName: 'notes.txt',
        mimeType: 'text/plain',
        fileSize: 12,
        type: KnowledgeType.FILE,
        content: Buffer.from('hello world!'),
        contentType: 'text/plain',
      },
      mockAdapters
    );

    expect(storageGenerateSignedUrl).toHaveBeenCalledWith(expect.any(String), expect.any(Number), 'get');
    expect(result.fileUrl).toBe('https://s3.example.com/signed-url');
    expect(result.fileUrlExpireAt).toBeInstanceOf(Date);
  });

  it('mints only a PUT presignedUrl (never a GET fileUrl) when no content is provided (client-upload path, unaffected)', async () => {
    const result = await createFabFile(
      mockUserId,
      {
        fileName: 'photo.png',
        mimeType: 'image/png',
        fileSize: 2048,
        type: KnowledgeType.FILE,
      },
      mockAdapters
    );

    expect(storageGenerateSignedUrl).toHaveBeenCalledWith(expect.any(String), 600, 'put');
    expect(result.fileUrl).toBeUndefined();
    expect((result as { presignedUrl?: string }).presignedUrl).toBe('https://s3.example.com/signed-url');
  });

  // Audio (generated TTS / sound effects) is storable-but-not-ingestable: it was
  // previously rejected by the mime gate (audio isn't in SupportedFabFileMimeTypes),
  // and must now be accepted via isStorableFabFileMimeType and stored as AUDIO.
  it('accepts generated audio and stores it as AUDIO with a servable GET url', async () => {
    const result = await createFabFile(
      mockUserId,
      {
        fileName: 'speech-hello-1234.mp3',
        mimeType: 'audio/mpeg',
        fileSize: 4096,
        type: KnowledgeType.AUDIO,
        content: Buffer.from('fake-audio-bytes'),
        contentType: 'audio/mpeg',
        prefix: 'generated-audio',
      },
      mockAdapters
    );

    expect(storageUpload).toHaveBeenCalled();
    // Non-image content path: a GET url is minted immediately (no moderation hold).
    expect(storageGenerateSignedUrl).toHaveBeenCalledWith(expect.any(String), expect.any(Number), 'get');
    expect(result.fileUrl).toBe('https://s3.example.com/signed-url');

    const persistedData = fabFilesCreate.mock.calls[0][0];
    expect(persistedData.type).toBe(KnowledgeType.AUDIO);
    expect(persistedData.mimeType).toBe('audio/mpeg');
    // Stored under the generated-audio prefix with an .mp3 extension.
    expect(persistedData.filePath).toMatch(/^generated-audio\/.+\.mp3$/);
  });
});

// This is the door researchTaskService/process.ts and downloadRelevantLinks.ts create files
// through - it had NO lake-tag gating at all before this, unlike the update/toggle doors.
describe('createFabFile - lake-tag gate at create time', () => {
  const findByDatalakeTag = vi.fn().mockResolvedValue(null);

  const mockAdaptersFor = (isAdmin: boolean): CreateFabFileAdapters =>
    ({
      db: {
        fabFiles: { create: vi.fn().mockImplementation(async data => ({ id: 'fab-1', ...data })) },
        adminSettings: { findAll: vi.fn().mockResolvedValue([]), findBySettingNames: vi.fn().mockResolvedValue([]) },
        users: { findById: vi.fn().mockResolvedValue({ id: 'u1', isAdmin }) },
        dataLakes: { findByDatalakeTag },
      },
      storage: { generateSignedUrl: vi.fn().mockResolvedValue('url'), upload: vi.fn() },
    }) as unknown as CreateFabFileAdapters;

  it('refuses a non-admin creating a file with a static-registry-prefixed tag', async () => {
    await expect(
      createFabFile(
        'u1',
        { ...base, fileName: 'notes.txt', mimeType: 'text/plain', tags: [{ name: 'opti:report', strength: 1 }] },
        mockAdaptersFor(false)
      )
    ).rejects.toThrow(/only an admin can change this data lake/i);
  });

  it('allows an admin to create a file with a static-registry-prefixed tag', async () => {
    const result = await createFabFile(
      'u1',
      { ...base, fileName: 'notes.txt', mimeType: 'text/plain', tags: [{ name: 'opti:report', strength: 1 }] },
      mockAdaptersFor(true)
    );
    expect(result.id).toBe('fab-1');
  });

  it('refuses a datalake:* meta-tag naming no lake, even for the fallback researchTaskService path', async () => {
    await expect(
      createFabFile(
        'u1',
        {
          ...base,
          fileName: 'notes.txt',
          mimeType: 'text/plain',
          tags: [{ name: 'datalake:ghost-lake', strength: 1 }],
        },
        mockAdaptersFor(false)
      )
    ).rejects.toThrow(/only the creator can change this data lake/i);
  });

  it('does not touch the dataLakes adapter for a create with no lake-related tags', async () => {
    findByDatalakeTag.mockClear();
    await createFabFile(
      'u1',
      { ...base, fileName: 'notes.txt', mimeType: 'text/plain', tags: [{ name: 'notes', strength: 1 }] },
      mockAdaptersFor(false)
    );
    expect(findByDatalakeTag).not.toHaveBeenCalled();
  });
});
