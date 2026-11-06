import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  claimUser: vi.fn(),
  exists: vi.fn(),
  updateOne: vi.fn(),
  organizationExists: vi.fn(),
  deletePersonalOrganizations: vi.fn(),
  hardDeleteUser: vi.fn(),
  purgeFiles: vi.fn(),
  purgeContent: vi.fn(),
  endRealtimeConnections: vi.fn(),
  sendComplete: vi.fn(),
  recordAdminAction: vi.fn(),
  collections: vi.fn(),
  order: [] as string[],
}));
vi.mock('@bike4mind/database', () => ({
  User: {
    findOneAndUpdate: (...args: unknown[]) => ({ lean: () => h.claimUser(...args) }),
    exists: h.exists,
    updateOne: h.updateOne,
  },
  Organization: { exists: h.organizationExists, deleteMany: h.deletePersonalOrganizations },
  realtimeConnectionRepository: {},
  adminAuditLogRepository: { append: vi.fn() },
}));
vi.mock('@bike4mind/services', () => ({
  authSessionService: { endRealtimeConnections: h.endRealtimeConnections },
  adminAuditService: { recordAdminAction: h.recordAdminAction },
}));
vi.mock('@server/services/hardDeleteUser', () => ({ hardDeleteUser: h.hardDeleteUser }));
vi.mock('./purgeAccountFiles', () => ({ purgeAccountFiles: h.purgeFiles }));
vi.mock('./purgeAccountContent', () => ({ purgeAccountContent: h.purgeContent }));
vi.mock('./accountDeletionEmail', () => ({ sendAccountDeletionCompleteEmail: h.sendComplete }));
vi.mock('@server/dataSubject/subjectErasurePlan', () => ({
  SubjectErasurePlan: class {
    collections = (...args: unknown[]) => h.collections(...args);
  },
  unerased: (collections: { deleted: number; anonymized: number }[]) =>
    collections.filter(collection => collection.deleted + collection.anonymized > 0),
}));
vi.mock('@server/utils/adminAudit', () => ({
  systemAuditActor: (name: string) => ({ kind: 'system', scope: 'platform', name, wasAdmin: false }),
}));

import { completeAccountDeletion } from './completeAccountDeletion';

const USER_ID = '665f1c2e8b3a4d0000000001';
const NOW = new Date('2026-11-04T00:00:00.000Z');
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const users = {
  delete: vi.fn(async () => {
    h.order.push('delete');
  }),
};
const complete = () => completeAccountDeletion(USER_ID, { logger: logger as never, now: NOW });
type HardDeleteContext = {
  assertInTransaction?: () => Promise<void>;
  recordInTransaction?: (target: unknown) => Promise<void>;
};
const deletedTarget = { name: 'Leaving User', username: 'leaving', email: 'leaving@example.com' };

beforeEach(() => {
  vi.resetAllMocks();
  h.order.length = 0;
  h.exists.mockResolvedValue({ _id: USER_ID });
  h.claimUser.mockResolvedValue({ email: 'leaving@example.com' });
  h.organizationExists.mockResolvedValue(null);
  h.purgeFiles.mockImplementation(async () => {
    h.order.push('files');
  });
  h.purgeContent.mockImplementation(async () => {
    h.order.push('content');
  });
  h.collections.mockResolvedValue([]);
  h.endRealtimeConnections.mockImplementation(async () => {
    h.order.push('realtime');
  });
  users.delete.mockImplementation(async () => {
    h.order.push('delete');
  });
  h.sendComplete.mockImplementation(async () => {
    h.order.push('email');
  });
  h.recordAdminAction.mockImplementation(async () => {
    h.order.push('audit');
  });
  h.hardDeleteUser.mockImplementation(
    async (_id: string, context: HardDeleteContext, commitDelete: (repository: typeof users) => Promise<unknown>) => {
      await context.assertInTransaction?.();
      const result = await commitDelete(users);
      await context.recordInTransaction?.(deletedTarget);
      return { result, subscriptionCancellation: null };
    }
  );
});

describe('completeAccountDeletion', () => {
  it('skips a cancelled or not-yet-due account before claiming or deleting anything', async () => {
    h.exists.mockResolvedValueOnce(null);
    await expect(complete()).resolves.toEqual({ deleted: false, reason: 'not_due' });
    expect(h.claimUser).not.toHaveBeenCalled();
    expect(h.purgeFiles).not.toHaveBeenCalled();
    expect(h.hardDeleteUser).not.toHaveBeenCalled();
  });

  it('skips a missing user', async () => {
    h.exists.mockResolvedValue(null);
    await expect(complete()).resolves.toEqual({ deleted: false, reason: 'not_found' });
  });

  it('claims the irreversible phase atomically against cancellation', async () => {
    await complete();
    expect(h.claimUser).toHaveBeenCalledWith(
      {
        _id: USER_ID,
        'deletion.scheduledFor': { $lte: NOW },
        'deletion.purgeStartedAt': null,
        $or: [
          { 'accountDataExportLease.expiresAt': null },
          { 'accountDataExportLease.expiresAt': { $lte: expect.any(Date) } },
        ],
      },
      {
        $set: {
          'deletion.purgeStartedAt': expect.any(Date),
          'deletion.purgeLeaseId': expect.any(String),
          'deletion.purgeLeaseExpiresAt': expect.any(Date),
        },
      },
      {
        new: true,
        projection: {
          email: 1,
          'deletion.source': 1,
          'deletion.requestedBy': 1,
          'deletion.erasureScope': 1,
        },
      }
    );
    expect(h.order).toEqual(['files', 'content', 'realtime', 'delete', 'audit', 'email']);
    expect(h.deletePersonalOrganizations).toHaveBeenCalledWith(
      { userId: USER_ID, personal: true },
      { hardDelete: true }
    );
  });

  it('does no purge when cancellation or another worker wins the atomic claim', async () => {
    h.claimUser.mockResolvedValue(null);
    await expect(complete()).resolves.toEqual({ deleted: false, reason: 'not_due' });
    expect(h.purgeFiles).not.toHaveBeenCalled();
    expect(h.purgeContent).not.toHaveBeenCalled();
    expect(h.hardDeleteUser).not.toHaveBeenCalled();
  });

  it('reclaims an expired lease without resetting the irreversible start marker', async () => {
    h.claimUser.mockResolvedValueOnce(null).mockResolvedValueOnce({ email: 'leaving@example.com' });
    await expect(complete()).resolves.toEqual({ deleted: true });
    const [filter, update] = h.claimUser.mock.calls[1];
    expect(filter).toMatchObject({
      _id: USER_ID,
      'deletion.purgeStartedAt': { $ne: null },
      $and: [
        {
          $or: [
            { 'accountDataExportLease.expiresAt': null },
            { 'accountDataExportLease.expiresAt': { $lte: expect.any(Date) } },
          ],
        },
        {
          $or: [
            { 'deletion.purgeLeaseExpiresAt': null },
            { 'deletion.purgeLeaseExpiresAt': { $lte: expect.any(Date) } },
          ],
        },
      ],
    });
    expect(update).toEqual({
      $set: {
        'deletion.purgeLeaseId': expect.any(String),
        'deletion.purgeLeaseExpiresAt': expect.any(Date),
      },
    });
  });

  it.each(['files', 'content'])(
    'keeps the pending user and releases only its lease when %s purge fails',
    async step => {
      const purge = step === 'files' ? h.purgeFiles : h.purgeContent;
      purge.mockRejectedValueOnce(new Error('retryable purge failure'));
      await expect(complete()).rejects.toThrow('retryable purge failure');
      expect(users.delete).not.toHaveBeenCalled();
      expect(h.sendComplete).not.toHaveBeenCalled();
      expect(h.updateOne).toHaveBeenCalledWith(
        { _id: USER_ID, 'deletion.purgeLeaseId': expect.any(String) },
        { $unset: { 'deletion.purgeLeaseId': 1, 'deletion.purgeLeaseExpiresAt': 1 } }
      );
    }
  );

  it('does not delete or email after losing its lease', async () => {
    h.exists.mockResolvedValueOnce({ _id: USER_ID }).mockResolvedValue(null);
    await expect(complete()).rejects.toThrow('purge lease lost');
    expect(h.hardDeleteUser).not.toHaveBeenCalled();
    expect(h.sendComplete).not.toHaveBeenCalled();
  });

  it('refuses an organization owner before claiming the purge', async () => {
    h.organizationExists.mockResolvedValue({ _id: 'organization' });
    await expect(complete()).rejects.toThrow('still owns an organization');
    expect(h.organizationExists).toHaveBeenCalledWith({ userId: USER_ID, deletedAt: null, personal: { $ne: true } });
    expect(h.claimUser).not.toHaveBeenCalled();
  });

  it('rechecks ownership in the final delete transaction', async () => {
    h.organizationExists.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: 'organization' });
    await expect(complete()).rejects.toThrow('still owns an organization');
    expect(users.delete).not.toHaveBeenCalled();
    expect(h.sendComplete).not.toHaveBeenCalled();
  });

  it('fails closed on an ownership lookup error', async () => {
    h.organizationExists.mockRejectedValue(new Error('ownership unavailable'));
    await expect(complete()).rejects.toThrow('ownership unavailable');
    expect(h.claimUser).not.toHaveBeenCalled();
  });

  it('preserves the original failure if releasing the lease also fails', async () => {
    h.purgeContent.mockRejectedValue(new Error('purge unavailable'));
    h.updateOne.mockRejectedValue(new Error('release unavailable'));
    await expect(complete()).rejects.toThrow('purge unavailable');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('release unavailable'));
  });

  it('emails only after completion and tolerates a delivery failure', async () => {
    h.sendComplete.mockRejectedValue(new Error('bus down'));
    await expect(complete()).resolves.toEqual({ deleted: true });
    expect(users.delete).toHaveBeenCalledWith(USER_ID);
    expect(h.sendComplete).toHaveBeenCalledWith('leaving@example.com');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('bus down'));
  });

  it('sends no completion email without an address', async () => {
    h.claimUser.mockResolvedValue({ email: null });
    await expect(complete()).resolves.toEqual({ deleted: true });
    expect(h.sendComplete).not.toHaveBeenCalled();
  });

  it('records the completed deletion in the admin audit log inside the delete transaction', async () => {
    await expect(complete()).resolves.toEqual({ deleted: true });
    expect(h.recordAdminAction).toHaveBeenCalledWith(
      {
        action: 'user.deletion.completed',
        actor: { kind: 'system', scope: 'platform', name: 'account-deletion-sweep', wasAdmin: false },
        target: { kind: 'user', id: USER_ID, displayName: 'Leaving User' },
        summary: expect.any(String),
        details: { initiatedBy: 'self' },
        context: { source: 'worker' },
      },
      expect.objectContaining({ logger })
    );
    expect(JSON.stringify(h.recordAdminAction.mock.calls[0][0])).not.toContain('leaving@example.com');
    expect(h.order.slice(-3)).toEqual(['delete', 'audit', 'email']);
  });

  it('falls back to the user id when the deleted row is unreadable', async () => {
    h.hardDeleteUser.mockImplementation(
      async (_id: string, context: HardDeleteContext, commitDelete: (repository: typeof users) => Promise<unknown>) => {
        const result = await commitDelete(users);
        await context.recordInTransaction?.(null);
        return { result, subscriptionCancellation: null };
      }
    );
    await expect(complete()).resolves.toEqual({ deleted: true });
    expect(h.recordAdminAction.mock.calls[0][0].target).toEqual({ kind: 'user', id: USER_ID, displayName: USER_ID });
  });

  it('fails the delete transaction when the strict audit write fails, keeping the account for a retry', async () => {
    h.recordAdminAction.mockRejectedValue(new Error('audit store down'));
    await expect(complete()).rejects.toThrow('audit store down');
    expect(h.sendComplete).not.toHaveBeenCalled();
    expect(h.updateOne).toHaveBeenCalledWith(
      { _id: USER_ID, 'deletion.purgeLeaseId': expect.any(String) },
      { $unset: { 'deletion.purgeLeaseId': 1, 'deletion.purgeLeaseExpiresAt': 1 } }
    );
  });

  it('writes no audit entry when the delete fails', async () => {
    h.purgeContent.mockRejectedValue(new Error('purge unavailable'));
    await expect(complete()).rejects.toThrow('purge unavailable');
    expect(h.recordAdminAction).not.toHaveBeenCalled();
  });
});

describe('completeAccountDeletion for an admin data subject erasure', () => {
  const SCOPE = [{ name: 'quests', deleted: 3, anonymized: 0 }];
  const REMAINING = [
    { name: 'quests', deleted: 1, anonymized: 0 },
    { name: 'logs', deleted: 0, anonymized: 2 },
  ];
  const NOT_REMAINING = { name: 'notes', deleted: 0, anonymized: 0 };
  const adminUser = (extra: Record<string, unknown> = {}) => ({
    email: 'leaving@example.com',
    deletion: { source: 'admin', requestedBy: 'admin-1', ...extra },
  });

  beforeEach(() => {
    h.claimUser.mockResolvedValue(adminUser());
    h.collections.mockImplementation(async () => {
      h.order.push('plan');
      return SCOPE;
    });
  });

  it('snapshots the scope before the purge and stores it under the lease', async () => {
    await expect(complete()).resolves.toEqual({ deleted: true });

    expect(h.order.slice(0, 3)).toEqual(['plan', 'files', 'content']);
    expect(h.collections.mock.calls[0]).toEqual([expect.any(Function)]);
    expect(h.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: USER_ID, 'deletion.purgeLeaseId': expect.any(String) }),
      { $set: { 'deletion.erasureScope': SCOPE } }
    );
  });

  it('does not plan again before the purge when the scope is already stored', async () => {
    const stored = [{ name: 'quests', deleted: 9, anonymized: 0 }];
    h.claimUser.mockResolvedValue(adminUser({ erasureScope: stored }));
    h.collections.mockResolvedValue([]);

    await complete();

    expect(h.order[0]).toBe('files');
    expect(h.collections).toHaveBeenCalledTimes(1);
    expect(h.collections.mock.calls[0]).toEqual([]);
    expect(h.updateOne).not.toHaveBeenCalled();
    const details = h.recordAdminAction.mock.calls[0][0].details;
    expect(details.scope).toEqual(stored);
  });

  it('deletes as the admin and records the scope in the in-transaction completion entry', async () => {
    await complete();

    expect(h.hardDeleteUser).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ deletedBy: 'admin-1', initiatedBy: 'admin' }),
      expect.any(Function)
    );
    expect(h.recordAdminAction.mock.calls[0][0]).toMatchObject({
      action: 'user.deletion.completed',
      details: { initiatedBy: 'admin', requestedBy: 'admin-1', scope: SCOPE },
    });
  });

  it('checks what still names the person after the delete and records only the leftovers', async () => {
    h.collections.mockImplementation(async (...args: unknown[]) => {
      h.order.push('plan');
      return args.length > 0 ? SCOPE : [...REMAINING, NOT_REMAINING];
    });

    await expect(complete()).resolves.toEqual({ deleted: true });

    expect(h.order.indexOf('plan', h.order.indexOf('delete'))).toBeGreaterThan(h.order.indexOf('delete'));
    const completed = h.recordAdminAction.mock.calls.find(([entry]) => entry.action === 'user.erasure.completed');
    expect(completed?.[0]).toMatchObject({
      target: { kind: 'user', id: USER_ID, displayName: USER_ID },
      details: { requestedBy: 'admin-1', remaining: REMAINING },
    });
  });

  it.each([
    [
      'the post-delete plan',
      () => h.collections.mockImplementationOnce(async () => SCOPE).mockRejectedValueOnce(new Error('plan down')),
    ],
    [
      'the post-delete audit',
      () => h.recordAdminAction.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error('audit down')),
    ],
  ])('logs a failure of %s at error and still reports the deletion', async (_name, arrange) => {
    arrange();

    await expect(complete()).resolves.toEqual({ deleted: true });

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(USER_ID));
  });

  it('sends no completion email', async () => {
    await complete();

    expect(h.sendComplete).not.toHaveBeenCalled();
  });

  it('keeps the self path emailing and planning nothing', async () => {
    h.claimUser.mockResolvedValue({ email: 'leaving@example.com', deletion: { source: 'self' } });

    await complete();

    expect(h.collections).not.toHaveBeenCalled();
    expect(h.sendComplete).toHaveBeenCalledWith('leaving@example.com');
    expect(h.hardDeleteUser).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ deletedBy: USER_ID, initiatedBy: 'self' }),
      expect.any(Function)
    );
  });
});
