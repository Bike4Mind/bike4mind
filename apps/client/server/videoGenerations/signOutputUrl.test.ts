import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findById: vi.fn(),
  filesSign: vi.fn(),
  generatedSign: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({ fabFileRepository: { findById: h.findById } }));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ getSignedUrl: h.filesSign }),
  getGeneratedImageStorage: () => ({ getSignedUrl: h.generatedSign }),
}));

import { signOutputUrl } from './signOutputUrl';

const FILE_ID = '664f1c2b9a1e4d0012ab34cd';
const filesOutput = { location: 'files' as const, s3Key: 'generated-video/j.mp4', fileId: FILE_ID };

describe('signOutputUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.filesSign.mockResolvedValue('https://files.example/signed');
    h.generatedSign.mockResolvedValue('https://generated.example/signed');
  });

  it('signs a Files output once its FabFile is clean', async () => {
    h.findById.mockResolvedValue({ id: FILE_ID, moderationStatus: 'clean', mimeType: 'video/mp4' });
    await expect(signOutputUrl(filesOutput, 900)).resolves.toEqual({
      availability: 'ready',
      url: 'https://files.example/signed',
    });
    expect(h.findById).toHaveBeenCalledWith(FILE_ID);
    expect(h.filesSign).toHaveBeenCalledWith('generated-video/j.mp4', 'get', { expiresIn: 900 });
  });

  it.each(['pending', 'scanning'])('reports pending_scan while moderationStatus is %s', async moderationStatus => {
    h.findById.mockResolvedValue({ id: FILE_ID, moderationStatus, mimeType: 'video/mp4' });
    await expect(signOutputUrl(filesOutput, 900)).resolves.toEqual({ availability: 'pending_scan' });
    expect(h.filesSign).not.toHaveBeenCalled();
  });

  it.each(['blocked', null, undefined])(
    'reports unavailable when moderationStatus is %s: it can never turn clean',
    async moderationStatus => {
      h.findById.mockResolvedValue({ id: FILE_ID, moderationStatus, mimeType: 'video/mp4' });
      await expect(signOutputUrl(filesOutput, 900)).resolves.toEqual({ availability: 'unavailable' });
      expect(h.filesSign).not.toHaveBeenCalled();
    }
  );

  it('reports unavailable when the FabFile is missing or deleted', async () => {
    h.findById.mockResolvedValueOnce(null);
    await expect(signOutputUrl(filesOutput, 900)).resolves.toEqual({ availability: 'unavailable' });
    h.findById.mockResolvedValueOnce({ id: FILE_ID, moderationStatus: 'pending', deletedAt: new Date() });
    await expect(signOutputUrl(filesOutput, 900)).resolves.toEqual({ availability: 'unavailable' });
    expect(h.filesSign).not.toHaveBeenCalled();
  });

  it('reports unavailable when the output records no usable file id, without querying', async () => {
    await expect(signOutputUrl({ ...filesOutput, fileId: undefined }, 900)).resolves.toEqual({
      availability: 'unavailable',
    });
    await expect(signOutputUrl({ ...filesOutput, fileId: 'not-an-id' }, 900)).resolves.toEqual({
      availability: 'unavailable',
    });
    expect(h.findById).not.toHaveBeenCalled();
    expect(h.filesSign).not.toHaveBeenCalled();
  });

  it('signs generated-bucket output directly: it has no FabFile to gate', async () => {
    const output = { location: 'generated' as const, s3Key: 'generated-video/u1/j.mp4' };
    await expect(signOutputUrl(output, 900)).resolves.toEqual({
      availability: 'ready',
      url: 'https://generated.example/signed',
    });
    expect(h.generatedSign).toHaveBeenCalledWith('generated-video/u1/j.mp4', 'get', { expiresIn: 900 });
    expect(h.findById).not.toHaveBeenCalled();
    expect(h.filesSign).not.toHaveBeenCalled();
  });
});
