import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ list: vi.fn(), findById: vi.fn(), deny: vi.fn() }));

vi.mock('@bike4mind/database', () => ({
  adminAuditLogRepository: { list: h.list },
  userRepository: { findById: h.findById },
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({ getFilesStorage: () => ({}) }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  denySelfAdminAction: h.deny,
  isSelfOrImpersonator: (user: { id: string; impersonatedBy?: string }, targetId: string) =>
    user.id === targetId || user.impersonatedBy === targetId,
}));

import { ForbiddenError, NotFoundError } from '@bike4mind/common';
import {
  ADMIN_DATA_EXPORT_GIVE_UP_MS,
  adminDataExportStatus,
  denySelfDataExport,
  findDataExportTarget,
  listAdminDataExports,
} from './adminDataExports';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const USER_ID = '665f1c2e8b3a4d0012345678';
const notFound = () => Object.assign(new Error('Not Found'), { name: 'NotFound' });
type Entries = Record<string, unknown>[];
/** Answers the audit log list by action: the requests, and the requests that could not be queued. */
const auditLog = (requested: Entries, failed: Entries = []) =>
  h.list.mockImplementation(async ({ action }: { action: string }) => ({
    entries: action === 'user.data_export.failed' ? failed : requested,
    nextCursor: null,
  }));

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
    auditLog([
      {
        occurredAt: new Date(NOW - 2 * HOUR),
        actor: { name: 'Grace' },
        reason: 'Art. 15',
        details: { exportJobId: 'built' },
      },
      { occurredAt: new Date(NOW - 60_000), actor: { name: 'Grace' }, details: { exportJobId: 'pending' } },
      { occurredAt: new Date(NOW - HOUR), actor: { name: 'Grace' }, details: {} },
    ]);
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

  it('shows a request that could not be queued as failed at once, without reading storage', async () => {
    auditLog(
      [{ occurredAt: new Date(NOW - 60_000), actor: { name: 'Grace' }, details: { exportJobId: 'unqueued' } }],
      [{ occurredAt: new Date(NOW - 59_000), actor: { name: 'Grace' }, details: { exportJobId: 'unqueued' } }]
    );
    const getMetadata = vi.fn();

    const exports = await listAdminDataExports(USER_ID, { getMetadata } as never, NOW);

    expect(exports).toEqual([expect.objectContaining({ exportJobId: 'unqueued', status: { state: 'failed' } })]);
    expect(getMetadata).not.toHaveBeenCalled();
  });

  it('shows an export the worker skipped as failed with its reason, and ignores an unknown reason', async () => {
    const requested = (exportJobId: string) => ({
      occurredAt: new Date(NOW - 60_000),
      actor: { name: 'Grace' },
      details: { exportJobId },
    });
    auditLog(
      [requested('deleted'), requested('odd')],
      [
        {
          occurredAt: new Date(NOW - 30_000),
          actor: { name: 'worker' },
          details: { exportJobId: 'deleted', skipReason: 'deletion_due' },
        },
        {
          occurredAt: new Date(NOW - 30_000),
          actor: { name: 'worker' },
          details: { exportJobId: 'odd', skipReason: 'unheard_of' },
        },
      ]
    );

    const exports = await listAdminDataExports(USER_ID, { getMetadata: vi.fn() } as never, NOW);

    expect(exports.map(entry => entry.status)).toEqual([
      { state: 'failed', reason: 'deletion_due' },
      { state: 'failed' },
    ]);
  });

  it('shows the newest skip reason when the worker recorded more than one for the same export', async () => {
    const skipped = (skipReason: string, ageMs: number) => ({
      occurredAt: new Date(NOW - ageMs),
      actor: { name: 'worker' },
      details: { exportJobId: 'retried', skipReason },
    });
    auditLog(
      [{ occurredAt: new Date(NOW - 60_000), actor: { name: 'Grace' }, details: { exportJobId: 'retried' } }],
      [skipped('account_gone', 10_000), skipped('deletion_won_admission', 40_000)]
    );

    const exports = await listAdminDataExports(USER_ID, { getMetadata: vi.fn() } as never, NOW);

    expect(exports.map(entry => entry.status)).toEqual([{ state: 'failed', reason: 'account_gone' }]);
  });

  it('surfaces a storage failure other than a missing object', async () => {
    auditLog([{ occurredAt: new Date(NOW), actor: { name: 'Grace' }, details: { exportJobId: 'x' } }]);
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

describe('denySelfDataExport', () => {
  const target = { user: { id: USER_ID }, auditTarget: { kind: 'user' as const, id: USER_ID, displayName: USER_ID } };

  beforeEach(() => {
    h.deny.mockReset().mockRejectedValue(new ForbiddenError('own account'));
  });

  it('denies an admin their own account and the account they impersonate', async () => {
    for (const user of [{ id: USER_ID }, { id: 'someone', impersonatedBy: USER_ID }]) {
      await expect(denySelfDataExport({ user } as never, target, 'user.data_export.requested')).rejects.toThrow(
        'own account'
      );
    }
    expect(h.deny).toHaveBeenCalledWith(expect.anything(), {
      action: 'user.data_export.denied',
      attempted: 'user.data_export.requested',
      target: target.auditTarget,
    });
  });

  it('lets an admin export someone else', async () => {
    await expect(
      denySelfDataExport({ user: { id: 'admin-1' } } as never, target, 'user.data_export.downloaded')
    ).resolves.toBeUndefined();
    expect(h.deny).not.toHaveBeenCalled();
  });
});
