import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findByIdAndUserId: vi.fn(),
  findOne: vi.fn(),
  createFabFile: vi.fn(),
  download: vi.fn(),
  upload: vi.fn(),
}));

vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'https://ws.example.test' } } }));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ download: mocks.download, upload: mocks.upload, getSignedUrl: vi.fn() }),
  getGeneratedImageStorage: vi.fn(),
}));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: vi.fn() }));
vi.mock('@bike4mind/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/database')>();
  return {
    ...actual,
    fabFileRepository: { findByIdAndUserId: mocks.findByIdAndUserId, findOne: mocks.findOne },
  };
});
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return { ...actual, fabFilesService: { ...actual.fabFilesService, createFabFile: mocks.createFabFile } };
});

import { loadInputImage, saveToFiles } from './wiring';

const FILE_ID = '64b7f1c2a1b2c3d4e5f60718';
const image = { id: FILE_ID, filePath: 'uploads/a.png', mimeType: 'image/png', moderationStatus: 'clean' };

describe('loadInputImage', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns the bytes and mime type of the owner image', async () => {
    mocks.findByIdAndUserId.mockResolvedValue(image);
    mocks.download.mockResolvedValue(Buffer.from('png'));
    await expect(loadInputImage('user1', FILE_ID)).resolves.toEqual({
      bytes: Buffer.from('png'),
      mimeType: 'image/png',
    });
    expect(mocks.findByIdAndUserId).toHaveBeenCalledWith(FILE_ID, 'user1');
  });

  it('returns null for a malformed id without querying', async () => {
    await expect(loadInputImage('user1', 'not-an-id')).resolves.toBeNull();
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
    await expect(loadInputImage('user1', FILE_ID)).resolves.toBeNull();
    expect(mocks.download).not.toHaveBeenCalled();
  });
});

describe('saveToFiles', () => {
  const params = { userId: 'user1', jobId: 'job1', bytes: Buffer.from('mp4'), contentType: 'video/mp4', prompt: 'p' };
  beforeEach(() => vi.resetAllMocks());

  it('returns the existing file for the job without creating another', async () => {
    mocks.findOne.mockResolvedValue({ id: 'f1', filePath: 'generated-video/x.mp4' });
    await expect(saveToFiles(params)).resolves.toEqual({ saved: true, fileId: 'f1', s3Key: 'generated-video/x.mp4' });
    expect(mocks.createFabFile).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('creates the file when none exists for the job', async () => {
    mocks.findOne.mockResolvedValue(null);
    mocks.createFabFile.mockResolvedValue({ id: 'f2', filePath: 'generated-video/y.mp4' });
    await expect(saveToFiles(params)).resolves.toEqual({ saved: true, fileId: 'f2', s3Key: 'generated-video/y.mp4' });
  });

  // The FabFile extension map lists no video containers, so the provider's claimed type must outrank the name.
  it('stores the clip under its own extension with the claimed type taking precedence', async () => {
    mocks.findOne.mockResolvedValue(null);
    mocks.createFabFile.mockResolvedValue({ id: 'f3', filePath: 'generated-video/z.webm' });
    await saveToFiles({ ...params, contentType: 'video/webm' });
    const [, input, adapters] = mocks.createFabFile.mock.calls[0];
    expect(input).toMatchObject({ fileName: 'video-job1.webm', mimeType: 'video/webm' });
    expect(adapters).toMatchObject({ mimeTypePrecedence: 'claim-first' });
  });

  it('refuses a non-video content type without creating a file', async () => {
    mocks.findOne.mockResolvedValue(null);
    await expect(saveToFiles({ ...params, contentType: 'text/html' })).resolves.toEqual({
      saved: false,
      reason: 'error',
    });
    expect(mocks.createFabFile).not.toHaveBeenCalled();
  });

  it.each([
    ['storage limit exceeded', 'storage_limit'],
    ['File size exceeds maximum file size', 'file_too_large'],
    ['something else broke', 'error'],
  ])('maps the failure "%s" to %s', async (message, reason) => {
    mocks.findOne.mockResolvedValue(null);
    mocks.createFabFile.mockRejectedValue(new Error(message));
    await expect(saveToFiles(params)).resolves.toEqual({ saved: false, reason });
  });
});
