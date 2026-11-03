// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({ findById: vi.fn(), getSignedUrl: vi.fn() }));

vi.mock('@bike4mind/database', () => ({ fabFileRepository: { findById: m.findById } }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ getSignedUrl: m.getSignedUrl }),
}));

import { INCIDENT_IMAGE_LINK_TTL_SECONDS, signIncidentImage } from './incidentImageLink';

const FILE_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';

describe('signIncidentImage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.findById.mockResolvedValue({ filePath: 'uploads/u1/pic.png', mimeType: 'image/png' });
    m.getSignedUrl.mockResolvedValue('https://signed.example/pic');
  });

  it('signs one inline read of the stored object for five minutes', async () => {
    const now = new Date('2026-10-30T10:00:00Z');
    const image = await signIncidentImage({ fabFileId: FILE_ID }, now);

    expect(INCIDENT_IMAGE_LINK_TTL_SECONDS).toBe(300);
    expect(m.getSignedUrl).toHaveBeenCalledTimes(1);
    expect(m.getSignedUrl).toHaveBeenCalledWith('uploads/u1/pic.png', 'get', {
      expiresIn: 300,
      audience: 'browser',
      ResponseContentType: 'image/png',
      ResponseContentDisposition: 'inline',
    });
    expect(image).toEqual({
      availability: 'ready',
      url: 'https://signed.example/pic',
      expiresAt: '2026-10-30T10:05:00.000Z',
    });
  });

  it.each([[{}], [{ fabFileId: 'not-an-id' }]])('has no stored image for %j', async incident => {
    expect(await signIncidentImage(incident)).toEqual({ availability: 'unavailable', reason: 'no_stored_image' });
    expect(m.getSignedUrl).not.toHaveBeenCalled();
  });

  it('has no stored image when the file record is gone', async () => {
    m.findById.mockResolvedValue(null);
    expect(await signIncidentImage({ fabFileId: FILE_ID })).toEqual({
      availability: 'unavailable',
      reason: 'no_stored_image',
    });
  });

  it.each(['image/svg+xml', 'text/html', 'application/pdf'])('refuses to link %s', async mimeType => {
    m.findById.mockResolvedValue({ filePath: 'uploads/u1/x', mimeType });
    expect(await signIncidentImage({ fabFileId: FILE_ID })).toEqual({
      availability: 'unavailable',
      reason: 'not_displayable',
    });
    expect(m.getSignedUrl).not.toHaveBeenCalled();
  });
});
