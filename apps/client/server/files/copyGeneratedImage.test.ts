import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const h = vi.hoisted(() => ({
  findSessionIdsByImage: vi.fn(),
  findAllAccessibleByIds: vi.fn(),
  findOne: vi.fn(),
  download: vi.fn(),
  getMetadata: vi.fn(),
  saveGeneratedAsset: vi.fn(),
  consumeFileUploadBudget: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock('@server/files/fileUploadBudget', () => ({ consumeFileUploadBudget: h.consumeFileUploadBudget }));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: h.logEvent }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ upload: vi.fn(), getSignedUrl: vi.fn() }),
  getGeneratedImageStorage: () => ({ download: h.download, getMetadata: h.getMetadata }),
}));
vi.mock('@bike4mind/services', () => ({ saveGeneratedAsset: h.saveGeneratedAsset }));
vi.mock('@bike4mind/database', () => ({
  User: {},
  organizationRepository: {},
  adminSettingsRepository: {},
  scopedSettingsRepository: {},
  dataLakeRepository: {},
  fabFileRepository: { findOne: h.findOne },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
  questRepository: { findSessionIdsByImage: h.findSessionIdsByImage },
  sessionRepository: { shareable: { findAllAccessibleByIds: h.findAllAccessibleByIds } },
}));

import { copyGeneratedImageToFiles } from './copyGeneratedImage';

const KEY = '9db8f846-08d5-47d7-9166-a039d3c3d4d7.png';
const req = () =>
  ({
    user: { id: 'me', groups: [] },
    ability: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }) as unknown as Request;
const GENERATION = { generator: 'image', provider: 'openai', prompt: 'a lighthouse' };

describe('copyGeneratedImageToFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findSessionIdsByImage.mockResolvedValue(['s1']);
    h.findAllAccessibleByIds.mockResolvedValue([{ id: 's1' }]);
    h.findOne.mockResolvedValue(null);
    h.getMetadata.mockResolvedValue({ contentType: 'image/png' });
    h.download.mockResolvedValue(Buffer.from('image-bytes'));
    h.saveGeneratedAsset.mockResolvedValue({ saved: true, fileId: 'file-new' });
  });

  it('refuses an image the caller may not read, before touching its bytes', async () => {
    h.findAllAccessibleByIds.mockResolvedValue([]);

    await expect(copyGeneratedImageToFiles(req(), { imageS3Key: KEY })).rejects.toThrow(/access/i);
    expect(h.download).not.toHaveBeenCalled();
    expect(h.consumeFileUploadBudget).not.toHaveBeenCalled();
  });

  it('returns the caller own generated file as-is, without spending the upload budget', async () => {
    h.findOne.mockResolvedValue({ id: 'file-own', userId: 'me', sourceMetadata: { generation: GENERATION } });

    await expect(copyGeneratedImageToFiles(req(), { imageS3Key: KEY })).resolves.toEqual({
      fileId: 'file-own',
      created: false,
    });
    expect(h.consumeFileUploadBudget).not.toHaveBeenCalled();
    expect(h.saveGeneratedAsset).not.toHaveBeenCalled();
  });

  it('saves a new copy, spending one unit of the budget and logging the new file', async () => {
    await expect(copyGeneratedImageToFiles(req(), { imageS3Key: KEY })).resolves.toEqual({
      fileId: 'file-new',
      created: true,
    });
    expect(h.consumeFileUploadBudget).toHaveBeenCalledWith(expect.anything(), 1);
    expect(h.saveGeneratedAsset).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'me', generatedOutputKey: KEY, contentType: 'image/png' }),
      expect.anything()
    );
    expect(h.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'me', metadata: { fileId: 'file-new' } }),
      expect.anything()
    );
  });

  it('fails when the save is refused', async () => {
    h.saveGeneratedAsset.mockResolvedValue({ saved: false, cause: new Error('storage limit') });
    await expect(copyGeneratedImageToFiles(req(), { imageS3Key: KEY })).rejects.toThrow('storage limit');
    expect(h.logEvent).not.toHaveBeenCalled();
  });
});
