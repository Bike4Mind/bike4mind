import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IFabFileVersion } from '@bike4mind/common';

const { getFilesStorage, deleteMock } = vi.hoisted(() => ({ getFilesStorage: vi.fn(), deleteMock: vi.fn() }));

vi.mock('@server/utils/storage', () => ({ getFilesStorage }));
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));

import { deleteDroppedVersions } from './aiEditVersionRetention';

const version = (filePath: string): IFabFileVersion => ({
  version: 1,
  filePath,
  fileSize: 1,
  mimeType: 'x',
  createdAt: new Date(0),
});

describe('deleteDroppedVersions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getFilesStorage.mockReturnValue({ delete: deleteMock });
  });

  it('attempts every key even when one delete rejects', async () => {
    deleteMock.mockRejectedValueOnce(new Error('S3 unavailable')).mockResolvedValue(undefined);

    await expect(deleteDroppedVersions([version('a'), version('b')])).resolves.toBeUndefined();

    expect(deleteMock.mock.calls.map(([key]) => key)).toEqual(['a', 'b']);
  });

  it('does not throw when resolving the storage throws synchronously', async () => {
    getFilesStorage.mockImplementation(() => {
      throw new Error('storage not configured');
    });

    await expect(deleteDroppedVersions([version('a')])).resolves.toBeUndefined();
  });
});
