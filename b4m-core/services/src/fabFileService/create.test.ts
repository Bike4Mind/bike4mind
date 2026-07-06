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
});
