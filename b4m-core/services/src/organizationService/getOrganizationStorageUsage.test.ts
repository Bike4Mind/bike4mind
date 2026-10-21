import { describe, it, expect, vi } from 'vitest';
import {
  BYTES_PER_STORAGE_MB,
  DEFAULT_ORGANIZATION_STORAGE_LIMIT_MB,
  type OrganizationStorageUploaderGroup,
} from '@bike4mind/common';
import { getOrganizationStorageUsage, ORGANIZATION_STORAGE_UPLOADER_LIMIT } from './getOrganizationStorageUsage';

const adapters = (groups: OrganizationStorageUploaderGroup[], users: Array<Record<string, unknown>> = []) => ({
  db: {
    fabFiles: { summarizeChargedStorageByOrganizationId: vi.fn().mockResolvedValue(groups) },
    users: { findByIds: vi.fn().mockResolvedValue(users) },
  },
});

describe('getOrganizationStorageUsage', () => {
  it('reports the counter and the org limit in bytes, with named uploaders', async () => {
    const deps = adapters(
      [
        { userId: 'u1', bytes: 300, fileCount: 2 },
        { userId: 'u2', bytes: 100, fileCount: 1 },
      ],
      [
        { id: 'u1', name: 'Alice', username: 'alice', email: 'alice@example.com' },
        { id: 'u2', name: '', username: 'bob', email: 'bob@example.com' },
      ]
    );

    const usage = await getOrganizationStorageUsage({ id: 'o1', storageLimit: 5, currentStorageSize: 400 }, deps, {
      maxTimeMS: 1000,
    });

    expect(usage).toEqual({
      organizationId: 'o1',
      usedBytes: 400,
      limitBytes: 5 * BYTES_PER_STORAGE_MB,
      uploaders: [
        { userId: 'u1', bytes: 300, fileCount: 2, name: 'Alice', email: 'alice@example.com' },
        { userId: 'u2', bytes: 100, fileCount: 1, name: 'bob', email: 'bob@example.com' },
      ],
      uploadersTruncated: false,
    });
    expect(deps.db.fabFiles.summarizeChargedStorageByOrganizationId).toHaveBeenCalledWith('o1', {
      limit: ORGANIZATION_STORAGE_UPLOADER_LIMIT + 1,
      maxTimeMS: 1000,
    });
    expect(deps.db.users.findByIds).toHaveBeenCalledWith(['u1', 'u2']);
  });

  it('falls back to the default org limit and a zero counter when unset', async () => {
    const deps = adapters([]);
    const usage = await getOrganizationStorageUsage({ id: 'o1' }, deps);

    expect(usage.usedBytes).toBe(0);
    expect(usage.limitBytes).toBe(DEFAULT_ORGANIZATION_STORAGE_LIMIT_MB * BYTES_PER_STORAGE_MB);
    expect(usage.uploaders).toEqual([]);
    expect(deps.db.users.findByIds).not.toHaveBeenCalled();
  });

  it('clamps a drifted negative counter to zero', async () => {
    const usage = await getOrganizationStorageUsage({ id: 'o1', currentStorageSize: -50 }, adapters([]));
    expect(usage.usedBytes).toBe(0);
  });

  it('keeps an uploader whose account is gone, unnamed', async () => {
    const usage = await getOrganizationStorageUsage(
      { id: 'o1' },
      adapters([{ userId: 'gone', bytes: 10, fileCount: 1 }])
    );
    expect(usage.uploaders).toEqual([{ userId: 'gone', bytes: 10, fileCount: 1, name: null, email: null }]);
  });

  it('lists at most the uploader limit and flags the rest as truncated', async () => {
    const groups = Array.from({ length: ORGANIZATION_STORAGE_UPLOADER_LIMIT + 1 }, (_, index) => ({
      userId: `u${index}`,
      bytes: 1000 - index,
      fileCount: 1,
    }));
    const usage = await getOrganizationStorageUsage({ id: 'o1' }, adapters(groups));

    expect(usage.uploaders).toHaveLength(ORGANIZATION_STORAGE_UPLOADER_LIMIT);
    expect(usage.uploadersTruncated).toBe(true);
  });
});
