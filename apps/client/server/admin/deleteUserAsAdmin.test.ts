import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import type { AdminApproval } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  hardDeleteUser: vi.fn(),
  record: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  realtimeConnectionRepository: {},
  userRepository: { findById: mocks.findById },
}));
vi.mock('@bike4mind/server-utils/integrations/slack/slack', () => ({ postMessageToSlack: vi.fn() }));
vi.mock('@bike4mind/services', () => ({ userService: { adminDeleteUser: vi.fn() } }));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: vi.fn() } } }));
vi.mock('@server/services/hardDeleteUser', () => ({ hardDeleteUser: mocks.hardDeleteUser }));
vi.mock('@server/utils/adminAudit', () => ({
  isSelfOrImpersonator: (user: { id: string }, id: string) => user.id === id,
  recordAdminActionFromRequest: mocks.record,
}));
vi.mock('@server/billing/cancelAccountSubscriptions', () => ({
  subscriptionCancellationAudit: (cancellation: { canceled: string[] }) =>
    cancellation.canceled.length > 0
      ? { action: 'user.subscriptions.canceled', summary: 'canceled', details: { canceledSubscriptions: ['sub_1'] } }
      : null,
}));
vi.mock('@server/admin/creditGrants/approval', () => ({
  approvalDetails: (approval?: { id: string }) => (approval ? { approval: { id: approval.id } } : {}),
}));

import { deleteUserAsAdmin, executeApprovedAdminDelete } from './deleteUserAsAdmin';

type DeleteContext = { onDeleteFailed: (target: unknown, cancellation: unknown) => Promise<void> };

const APPROVAL = { id: 'approval-1' } as AdminApproval;
const req = { user: { id: 'approver' }, logger: {} } as unknown as Request;
const PARAMS = { userId: 'target', reason: 'offboarding' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hardDeleteUser.mockResolvedValue({ deleted: true });
});

describe('executeApprovedAdminDelete', () => {
  it('deletes a target that is still an admin', async () => {
    mocks.findById.mockResolvedValue({ id: 'target', isAdmin: true });
    await expect(executeApprovedAdminDelete(req, PARAMS, APPROVAL)).resolves.toEqual({ deletedUserId: 'target' });
    expect(mocks.hardDeleteUser).toHaveBeenCalledOnce();
  });

  it('answers 409 and deletes nothing when the target lost admin access after approval', async () => {
    mocks.findById.mockResolvedValue({ id: 'target', isAdmin: false, adminPermissions: [] });
    await expect(executeApprovedAdminDelete(req, PARAMS, APPROVAL)).rejects.toMatchObject({ statusCode: 409 });
    mocks.findById.mockResolvedValue(null);
    await expect(executeApprovedAdminDelete(req, PARAMS, APPROVAL)).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.hardDeleteUser).not.toHaveBeenCalled();
  });
});

describe('deleteUserAsAdmin onDeleteFailed', () => {
  const onDeleteFailed = async (approval?: AdminApproval) => {
    await deleteUserAsAdmin(req, 'target', 'offboarding', approval);
    const [, context] = mocks.hardDeleteUser.mock.calls[0] as [string, DeleteContext];
    await context.onDeleteFailed(null, { canceled: ['sub_1'], failed: [] });
    return mocks.record.mock.calls[0]?.[1] as { details?: Record<string, unknown> };
  };

  it('links the cancellation audit row to the approval that ran the delete', async () => {
    const entry = await onDeleteFailed(APPROVAL);
    expect(entry.details).toEqual({ canceledSubscriptions: ['sub_1'], approval: { id: 'approval-1' } });
  });

  it('records the cancellation without an approval link when none ran it', async () => {
    const entry = await onDeleteFailed();
    expect(entry.details).toEqual({ canceledSubscriptions: ['sub_1'] });
  });
});
