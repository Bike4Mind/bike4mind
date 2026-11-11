import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ upload: vi.fn(), getSignedUrl: vi.fn() }));

vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ upload: h.upload, getSignedUrl: h.getSignedUrl }),
}));

import { filesArchiveStorage } from './legacyQuestPlanArchiveStorage';

describe('filesArchiveStorage', () => {
  beforeEach(() => {
    h.upload.mockReset().mockResolvedValue('stored/key');
    h.getSignedUrl.mockReset().mockResolvedValue('https://signed.test/url');
  });

  it('uploads content-first with a markdown type and the byte length by default', async () => {
    await expect(filesArchiveStorage().upload('a/b.md', 'héllo')).resolves.toBe('stored/key');
    expect(h.upload).toHaveBeenCalledWith('héllo', 'a/b.md', { ContentType: 'text/markdown', ContentLength: 6 });
  });

  it('keeps an explicit content type and length', async () => {
    await filesArchiveStorage().upload('a/b.md', 'body', { ContentType: 'text/plain', ContentLength: 99 });
    expect(h.upload).toHaveBeenCalledWith('body', 'a/b.md', { ContentType: 'text/plain', ContentLength: 99 });
  });

  it('signs a read url unless another type is asked for', async () => {
    await expect(filesArchiveStorage().generateSignedUrl('a/b.md', 60)).resolves.toBe('https://signed.test/url');
    expect(h.getSignedUrl).toHaveBeenCalledWith('a/b.md', 'get', { expiresIn: 60 });
  });

  it('overwrites through the same upload, at the given key', async () => {
    const options = { ContentType: 'text/markdown', ContentLength: 4 };
    await expect(filesArchiveStorage().overwrite('a/b.md', 'body', options)).resolves.toBeUndefined();
    expect(h.upload).toHaveBeenCalledWith('body', 'a/b.md', options);
  });
});
