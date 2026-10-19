import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findByIdAndUserId: vi.fn(),
  findOne: vi.fn(),
  download: vi.fn(),
  upload: vi.fn(),
  generatedDownload: vi.fn(),
  findSessionIdsByImage: vi.fn(),
  findQuestById: vi.fn(),
  findAllByIds: vi.fn(),
  saveGeneratedAssetToFiles: vi.fn(),
}));

vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'https://ws.example.test' } } }));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ download: mocks.download, upload: mocks.upload, getSignedUrl: vi.fn() }),
  getGeneratedImageStorage: () => ({ download: mocks.generatedDownload }),
}));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: vi.fn() }));
vi.mock('@bike4mind/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/database')>();
  return {
    ...actual,
    fabFileRepository: { findByIdAndUserId: mocks.findByIdAndUserId, findOne: mocks.findOne },
    questRepository: { findSessionIdsByImage: mocks.findSessionIdsByImage, findById: mocks.findQuestById },
    sessionRepository: { findAllByIds: mocks.findAllByIds },
  };
});
vi.mock('@server/utils/saveGeneratedAssetToFiles', () => ({
  saveGeneratedAssetToFiles: (...a: unknown[]) => mocks.saveGeneratedAssetToFiles(...a),
}));

import { loadInputImage, saveToFiles } from './wiring';

const FILE_ID = '64b7f1c2a1b2c3d4e5f60718';
const image = { id: FILE_ID, filePath: 'uploads/a.png', mimeType: 'image/png', moderationStatus: 'clean' };

describe('loadInputImage', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns the bytes and mime type of the owner image', async () => {
    mocks.findByIdAndUserId.mockResolvedValue(image);
    mocks.download.mockResolvedValue(Buffer.from('png'));
    await expect(loadInputImage('user1', { kind: 'file', id: FILE_ID })).resolves.toEqual({
      bytes: Buffer.from('png'),
      mimeType: 'image/png',
    });
    expect(mocks.findByIdAndUserId).toHaveBeenCalledWith(FILE_ID, 'user1');
  });

  it('returns null for a malformed id without querying', async () => {
    await expect(loadInputImage('user1', { kind: 'file', id: 'not-an-id' })).resolves.toBeNull();
    expect(mocks.findByIdAndUserId).not.toHaveBeenCalled();
  });

  it.each([
    ['another user (not found for the owner scope)', null],
    ['a non-image mime type', { ...image, mimeType: 'application/pdf' }],
    ['a file with no filePath', { ...image, filePath: undefined }],
    ['a moderation-blocked image', { ...image, moderationStatus: 'blocked' }],
    ['a soft-deleted file', { ...image, deletedAt: new Date() }],
  ])('returns null for %s', async (_label, fabFile) => {
    mocks.findByIdAndUserId.mockResolvedValue(fabFile);
    await expect(loadInputImage('user1', { kind: 'file', id: FILE_ID })).resolves.toBeNull();
    expect(mocks.download).not.toHaveBeenCalled();
  });
});

describe('loadInputImage for a generated image', () => {
  const KEY = '86cdc650-43d2-416e-aca6-23ff4fe23081.webp';
  beforeEach(() => vi.resetAllMocks());

  it('returns the bytes of an owned key with the mime type of its extension', async () => {
    mocks.findSessionIdsByImage.mockResolvedValue(['s1']);
    mocks.findAllByIds.mockResolvedValue([{ userId: 'user1' }]);
    mocks.generatedDownload.mockResolvedValue(Buffer.from('webp'));
    await expect(loadInputImage('user1', { kind: 'generated', key: KEY })).resolves.toEqual({
      bytes: Buffer.from('webp'),
      mimeType: 'image/webp',
    });
    expect(mocks.findSessionIdsByImage).toHaveBeenCalledWith(KEY);
    expect(mocks.generatedDownload).toHaveBeenCalledWith(KEY);
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("returns null for a key in another user's session", async () => {
    mocks.findSessionIdsByImage.mockResolvedValue(['s1']);
    mocks.findAllByIds.mockResolvedValue([{ userId: 'someone-else' }]);
    await expect(loadInputImage('user1', { kind: 'generated', key: KEY })).resolves.toBeNull();
    expect(mocks.generatedDownload).not.toHaveBeenCalled();
  });

  it('returns null for a key no quest references', async () => {
    mocks.findSessionIdsByImage.mockResolvedValue([]);
    await expect(loadInputImage('user1', { kind: 'generated', key: KEY })).resolves.toBeNull();
    expect(mocks.generatedDownload).not.toHaveBeenCalled();
  });

  it.each(['../x.png', `generated/${KEY}`, '86cdc650-43d2-416e-aca6-23ff4fe23081.mp4', 'f1'])(
    'returns null for the malformed key %s without querying',
    async key => {
      await expect(loadInputImage('user1', { kind: 'generated', key })).resolves.toBeNull();
      expect(mocks.findSessionIdsByImage).not.toHaveBeenCalled();
      expect(mocks.generatedDownload).not.toHaveBeenCalled();
    }
  );
});

describe('saveToFiles', () => {
  beforeEach(() => vi.resetAllMocks());

  it('delegates to saveGeneratedAssetToFiles with the job params and returns its result', async () => {
    const params = {
      userId: 'user1',
      bytes: Buffer.from('mp4'),
      contentType: 'video/mp4',
      generation: { generator: 'video' as const, provider: 'veo', modelId: 'm', jobId: 'job1', prompt: 'p' },
      signal: new AbortController().signal,
    };
    const result = { saved: true as const, fileId: 'f1', s3Key: 'generated-video/x.mp4', fileName: 'video-job1.mp4' };
    mocks.saveGeneratedAssetToFiles.mockResolvedValue(result);
    await expect(saveToFiles(params)).resolves.toBe(result);
    expect(mocks.saveGeneratedAssetToFiles).toHaveBeenCalledTimes(1);
    expect(mocks.saveGeneratedAssetToFiles).toHaveBeenCalledWith(params, expect.anything());
  });

  it("links a chat job's clip to its quest's notebook", async () => {
    const params = {
      userId: 'u',
      bytes: Buffer.from('v'),
      contentType: 'video/mp4',
      generation: { generator: 'video' as const, provider: 'veo', jobId: 'j', prompt: 'p' },
      questId: 'q1',
      signal: new AbortController().signal,
    };
    mocks.findQuestById.mockResolvedValue({ id: 'q1', sessionId: 's1' });
    mocks.saveGeneratedAssetToFiles.mockResolvedValue({ saved: false, reason: 'error' });
    await saveToFiles(params);
    expect(mocks.findQuestById).toHaveBeenCalledWith('q1');
    expect(mocks.saveGeneratedAssetToFiles).toHaveBeenCalledWith({ ...params, sessionId: 's1' }, expect.anything());
  });

  it('passes a not-saved result through unchanged', async () => {
    mocks.saveGeneratedAssetToFiles.mockResolvedValue({ saved: false, reason: 'storage_limit' });
    await expect(
      saveToFiles({
        userId: 'u',
        bytes: Buffer.from('v'),
        contentType: 'video/mp4',
        generation: { generator: 'video', provider: 'veo', jobId: 'j', prompt: 'p' },
        signal: new AbortController().signal,
      })
    ).resolves.toEqual({ saved: false, reason: 'storage_limit' });
  });
});
