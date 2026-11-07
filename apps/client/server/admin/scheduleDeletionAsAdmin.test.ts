import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import type { AdminApproval, IUserDeletion } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({ findById: vi.fn(), schedule: vi.fn(), audit: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ userRepository: { findById: mocks.findById } }));
vi.mock('@server/users/accountDeletion', () => ({ scheduleAccountDeletion: mocks.schedule }));
vi.mock('@server/utils/adminAudit', () => ({
  isSelfOrImpersonator: (user: { id: string }, id: string) => user.id === id,
  recordAdminActionFromRequest: mocks.audit,
}));
vi.mock('@server/admin/creditGrants/approval', () => ({
  approvalDetails: (approval?: { id: string }) => (approval ? { approval: { id: approval.id } } : {}),
}));

vi.mock('@server/admin/creditGrants/grantOrg', () => ({ GrantOrgParamsSchema: {}, grantOrg: vi.fn() }));
vi.mock('@server/admin/creditGrants/grantSubscription', () => ({
  GrantSubscriptionParamsSchema: {},
  grantSubscription: vi.fn(),
}));
vi.mock('@server/admin/creditGrants/topUpOrg', () => ({ TopUpParamsSchema: {}, topUpOrg: vi.fn() }));
vi.mock('@server/admin/usersBulk/approvalExecutor', () => ({ executeApprovedUsersBulk: vi.fn() }));
vi.mock('@server/admin/deleteUserAsAdmin', () => ({
  DeleteAdminParamsSchema: {},
  executeApprovedAdminDelete: vi.fn(),
}));

import { scheduleDeletionAsAdmin } from './scheduleDeletionAsAdmin';
import { approvalExecutors } from './approvals/executors';

const request = { user: { id: 'approver' } } as unknown as Request;
const params = { userId: 'target', receivedAt: '2026-11-01', reason: 'Verified request from email on file' };
const approval = { id: 'approval-1', requestedBy: { selfIds: ['requester'] } } as AdminApproval;
const deletion: IUserDeletion = {
  requestedAt: new Date(params.receivedAt),
  scheduledFor: new Date('2026-11-20'),
  source: 'support',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findById.mockResolvedValue({ id: 'target', username: 'admin-target', isAdmin: true });
  mocks.audit.mockResolvedValue(undefined);
  mocks.schedule.mockImplementation(
    async (_req: unknown, input: { recordInTransaction: (stamp: IUserDeletion) => Promise<void> }) => {
      await input.recordInTransaction(deletion);
      return { deletion, subscriptions: { canceled: ['sub_1'] } };
    }
  );
});

describe('approved scheduled admin deletion', () => {
  it('schedules the original support request and links the transactional audit to its approval', async () => {
    await expect(
      approvalExecutors['user.schedule_admin_deletion'](params, { req: request, approval })
    ).resolves.toEqual({
      deletion,
      canceledSubscriptions: 1,
    });
    expect(mocks.schedule).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        userId: 'target',
        source: 'support',
        requestedAt: new Date(params.receivedAt),
        actorUserId: 'approver',
      })
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        action: 'user.deletion.scheduled',
        reason: params.reason,
        details: expect.objectContaining({
          approval: { id: approval.id },
          scheduledFor: deletion.scheduledFor.toISOString(),
        }),
      })
    );
  });

  it('refuses a target demoted before execution without scheduling anything', async () => {
    mocks.findById.mockResolvedValue({ id: 'target', isAdmin: false });
    await expect(scheduleDeletionAsAdmin(request, params, approval)).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('rechecks the admin role in the lockdown transaction before credential revocation', async () => {
    mocks.findById
      .mockResolvedValueOnce({ id: 'target', isAdmin: true })
      .mockResolvedValue({ id: 'target', isAdmin: false });
    await expect(scheduleDeletionAsAdmin(request, params, approval)).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each(['approver', 'requester'])('refuses either admin as the deletion target: %s', async userId => {
    await expect(scheduleDeletionAsAdmin(request, { ...params, userId }, approval)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('propagates transactional audit failure so lockdown rolls back', async () => {
    mocks.audit.mockRejectedValue(new Error('audit unavailable'));
    await expect(scheduleDeletionAsAdmin(request, params, approval)).rejects.toThrow('audit unavailable');
  });
});
