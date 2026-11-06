import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ list: vi.fn(), findById: vi.fn() }));

vi.mock('@bike4mind/database', () => ({
  adminAuditLogRepository: { list: h.list },
  userRepository: { findById: h.findById },
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({ getFilesStorage: () => ({}) }));

import { ForbiddenError, NotFoundError } from '@bike4mind/common';
import {
  ADMIN_DATA_EXPORT_GIVE_UP_MS,
  adminDataExportStatus,
  findDataExportTarget,
  listAdminDataExports,
} from './adminDataExports';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const USER_ID = '665f1c2e8b3a4d0012345678';
const notFound = () => Object.assign(new Error('Not Found'), { name: 'NotFound' });

beforeEach(() => {
  h.list.mockReset();
  h.findById.mockReset();
});

describe('adminDataExportStatus', () => {
  const requestedAt = new Date(NOW - 10 * 60 * 1000);

  it('is building until the give-up window passes, then failed', () => {
    expect(adminDataExportStatus(null, requestedAt, NOW)).toEqual({ state: 'building' });
    expect(adminDataExportStatus(null, requestedAt, requestedAt.getTime() + ADMIN_DATA_EXPORT_GIVE_UP_MS + 1)).toEqual({
      state: 'failed',
    });
  });

  it('is ready for a day after it is built, then expired', () => {
    const builtAt = new Date(NOW - HOUR);
    expect(adminDataExportStatus(builtAt, requestedAt, NOW)).toEqual({
      state: 'ready',
      builtAt: builtAt.toISOString(),
      expiresAt: new Date(builtAt.getTime() + 24 * HOUR).toISOString(),
    });
    expect(adminDataExportStatus(builtAt, requestedAt, builtAt.getTime() + 24 * HOUR)).toEqual({
      state: 'expired',
      builtAt: builtAt.toISOString(),
    });
  });
});

describe('listAdminDataExports', () => {
  it('reads the requests from the audit log and each status from storage', async () => {
    const builtAt = new Date(NOW - HOUR);
    h.list.mockResolvedValue({
      entries: [
        {
          occurredAt: new Date(NOW - 2 * HOUR),
          actor: { name: 'Grace' },
          reason: 'Art. 15',
          details: { exportJobId: 'built' },
        },
        { occurredAt: new Date(NOW - 60_000), actor: { name: 'Grace' }, details: { exportJobId: 'pending' } },
        { occurredAt: new Date(NOW - HOUR), actor: { name: 'Grace' }, details: {} },
      ],
      nextCursor: null,
    });
    const getMetadata = vi.fn(async (key: string) => {
      if (key.includes('/admin/built/')) return { lastModified: builtAt };
      throw notFound();
    });

    const exports = await listAdminDataExports(USER_ID, { getMetadata } as never, NOW);

    expect(h.list).toHaveBeenCalledWith(
      {
        action: 'user.data_export.requested',
        targetKind: 'user',
        targetId: USER_ID,
        from: new Date(NOW - 24 * HOUR - ADMIN_DATA_EXPORT_GIVE_UP_MS).toISOString(),
      },
      { limit: 20 }
    );
    expect(exports).toEqual([
      {
        exportJobId: 'built',
        requestedAt: new Date(NOW - 2 * HOUR).toISOString(),
        requestedBy: 'Grace',
        reason: 'Art. 15',
        status: { state: 'ready', builtAt: builtAt.toISOString(), expiresAt: expect.any(String) },
      },
      {
        exportJobId: 'pending',
        requestedAt: new Date(NOW - 60_000).toISOString(),
        requestedBy: 'Grace',
        reason: null,
        status: { state: 'building' },
      },
    ]);
  });

  it('surfaces a storage failure other than a missing object', async () => {
    h.list.mockResolvedValue({
      entries: [{ occurredAt: new Date(NOW), actor: { name: 'Grace' }, details: { exportJobId: 'x' } }],
      nextCursor: null,
    });
    const getMetadata = vi.fn().mockRejectedValue(new Error('AccessDenied'));

    await expect(listAdminDataExports(USER_ID, { getMetadata } as never, NOW)).rejects.toThrow('AccessDenied');
  });
});

describe('findDataExportTarget', () => {
  it('refuses an unknown user', async () => {
    h.findById.mockResolvedValue(null);
    await expect(findDataExportTarget({ isAdmin: true }, USER_ID)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('lets only a full admin export an admin', async () => {
    h.findById.mockResolvedValue({ id: USER_ID, isAdmin: true, email: 'root@example.com' });
    await expect(
      findDataExportTarget({ isAdmin: false, adminPermissions: ['users:export'] }, USER_ID)
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(findDataExportTarget({ isAdmin: true }, USER_ID)).resolves.toMatchObject({
      auditTarget: { kind: 'user', id: USER_ID, displayName: 'root@example.com' },
    });
  });
});
