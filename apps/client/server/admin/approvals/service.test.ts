import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { approvalParamsHash, canonicalApprovalJson, type AdminApproval } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({
  repo: { create: vi.fn(), findById: vi.fn(), list: vi.fn(), claim: vi.fn(), finish: vi.fn() },
  record: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({ adminApprovalRepository: mocks.repo, adminSettingsRepository: {} }));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: vi.fn(async () => ({})),
  getSettingsValue: (_key: string, _settings: unknown, fallback: unknown) => fallback,
}));
vi.mock('@server/utils/adminAudit', async () => {
  const { ForbiddenError } = await import('@bike4mind/common');
  return {
    recordAdminActionFromRequest: mocks.record,
    isSameUserId: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
    isSelfOrImpersonator: (user: { id: string; impersonatedBy?: string }, id: string) =>
      user.id === id || user.impersonatedBy === id,
    denySelfAdminAction: async (_req: unknown, input: { message: string }) => {
      await mocks.record(_req, input);
      throw new ForbiddenError(input.message);
    },
    requestAuditWriter: () => vi.fn(),
  };
});
vi.mock('./executors', () => ({
  approvalExecutors: new Proxy({}, { get: () => mocks.execute }),
}));

import { approveApproval, listApprovals, redeemApproval, rejectApproval, requestApproval } from './service';

const REQUESTER = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const APPROVER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const ID = 'cccccccccccccccccccccccc';
const PARAMS = { target: { kind: 'ids', userIds: ['u1', 'u2'] }, action: { type: 'suspend' } };

const reqAs = (user: Record<string, unknown>) => ({ user, logger: {} }) as unknown as Request;
const fullAdmin = (id: string, extra: Record<string, unknown> = {}) => reqAs({ id, name: id, isAdmin: true, ...extra });

const approvalOf = (overrides: Partial<AdminApproval> = {}): AdminApproval => {
  const paramsJson = canonicalApprovalJson(PARAMS);
  return {
    id: ID,
    action: 'users.bulk',
    paramsJson,
    paramsHash: approvalParamsHash(paramsJson),
    summary: 'Suspend 2 users',
    requestedBy: { id: REQUESTER, name: 'Ada', email: 'ada@example.com', selfIds: [REQUESTER] },
    reason: 'spam wave',
    requiredPermission: 'users:moderate',
    requiresFullAdmin: false,
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    ...overrides,
  };
};

const auditActions = () => mocks.record.mock.calls.map(([, input]) => (input as { action: string }).action);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.repo.findById.mockResolvedValue(approvalOf());
  mocks.repo.claim.mockImplementation(async (_id, _from, to) => approvalOf({ status: to }));
  mocks.repo.finish.mockImplementation(async (_id, _from, to, set) => approvalOf({ status: to, ...set }));
  mocks.execute.mockResolvedValue({ updated: 2 });
});

describe('requestApproval', () => {
  it('stores canonical params with their hash and the requester self ids', async () => {
    mocks.repo.create.mockImplementation(async input => ({
      ...input,
      id: ID,
      status: 'pending',
      createdAt: new Date(),
    }));
    const body = await requestApproval(fullAdmin(REQUESTER, { impersonatedBy: 'dddddddddddddddddddddddd' }), {
      action: 'users.bulk',
      params: { action: { type: 'suspend' }, target: { userIds: ['u1', 'u2'], kind: 'ids' } },
      summary: 'Suspend 2 users',
      reason: 'spam wave',
      requiredPermission: 'users:moderate',
      requiresFullAdmin: true,
    });
    const stored = mocks.repo.create.mock.calls[0]?.[0];
    expect(stored.requiresFullAdmin).toBe(true);
    expect(stored.paramsJson).toBe(canonicalApprovalJson(PARAMS));
    expect(stored.paramsHash).toBe(approvalParamsHash(stored.paramsJson));
    expect(stored.requestedBy.selfIds).toEqual([REQUESTER, 'dddddddddddddddddddddddd']);
    expect(body).toMatchObject({ approvalId: ID, status: 'pending' });
    expect(auditActions()).toEqual(['admin.approval.requested']);
  });

  it('rethrows the requested audit error when its rollback also fails', async () => {
    mocks.repo.create.mockImplementation(async input => ({
      ...input,
      id: ID,
      status: 'pending',
      createdAt: new Date(),
    }));
    mocks.record.mockRejectedValueOnce(new Error('audit down'));
    mocks.repo.finish.mockRejectedValueOnce(new Error('db down'));
    const error = vi.fn();
    const req = Object.assign(fullAdmin(REQUESTER), { logger: { error } });
    await expect(
      requestApproval(req, {
        action: 'users.bulk',
        params: PARAMS,
        summary: 'Suspend 2 users',
        reason: 'spam wave',
        requiredPermission: 'users:moderate',
        requiresFullAdmin: true,
      })
    ).rejects.toThrow('audit down');
    expect(error).toHaveBeenCalledWith('[ADMIN_APPROVAL_REQUEST_ROLLBACK_FAILED]', expect.anything());
  });
});

describe('approveApproval', () => {
  it('runs the stored params as the approver and records executed', async () => {
    const outcome = await approveApproval(fullAdmin(APPROVER), ID);
    expect(mocks.execute).toHaveBeenCalledWith(PARAMS, expect.objectContaining({ approval: expect.anything() }));
    expect(mocks.repo.claim).toHaveBeenCalledWith(
      ID,
      'pending',
      'executing',
      expect.objectContaining({ notRequestedBy: APPROVER }),
      expect.objectContaining({ decidedBy: { id: APPROVER, name: APPROVER } })
    );
    expect(mocks.repo.finish).toHaveBeenCalledWith(ID, 'executing', 'executed', expect.anything());
    expect(outcome.result).toEqual({ updated: 2 });
    expect(auditActions()).toEqual(['admin.approval.approved', 'admin.approval.executed']);
  });

  it('refuses the requester with a 403 and a denied audit row', async () => {
    await expect(approveApproval(fullAdmin(REQUESTER), ID)).rejects.toMatchObject({ statusCode: 403 });
    expect(auditActions()).toEqual(['admin.approval.denied']);
    expect(mocks.repo.claim).not.toHaveBeenCalled();
  });

  it('refuses an admin impersonating the requester', async () => {
    await expect(approveApproval(fullAdmin(APPROVER, { impersonatedBy: REQUESTER }), ID)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('refuses an approver who is impersonating the requester', async () => {
    await expect(approveApproval(fullAdmin(REQUESTER, { impersonatedBy: APPROVER }), ID)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(auditActions()).toEqual(['admin.approval.denied']);
    expect(mocks.repo.claim).not.toHaveBeenCalled();
  });

  it('refuses an approver whose own id is in the requester self ids', async () => {
    mocks.repo.findById.mockResolvedValue(
      approvalOf({ requestedBy: { id: REQUESTER, name: 'Ada', email: '', selfIds: [REQUESTER, APPROVER] } })
    );
    await expect(approveApproval(fullAdmin(APPROVER), ID)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('refuses a delegated admin without the record permission, and full-admin-only records', async () => {
    const delegated = reqAs({ id: APPROVER, adminPermissions: ['support:read'] });
    await expect(approveApproval(delegated, ID)).rejects.toMatchObject({ statusCode: 403 });
    mocks.repo.findById.mockResolvedValue(approvalOf({ requiresFullAdmin: true }));
    const moderator = reqAs({ id: APPROVER, adminPermissions: ['users:moderate'] });
    await expect(approveApproval(moderator, ID)).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.repo.claim).not.toHaveBeenCalled();
  });

  it('answers 410 and closes an expired record', async () => {
    mocks.repo.findById.mockResolvedValue(approvalOf({ expiresAt: new Date(Date.now() - 1) }));
    await expect(approveApproval(fullAdmin(APPROVER), ID)).rejects.toMatchObject({ statusCode: 410 });
    expect(mocks.repo.finish).toHaveBeenCalledWith(ID, 'pending', 'expired');
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('answers 409 without running anything when the stored params were changed', async () => {
    const tampered = canonicalApprovalJson({ ...PARAMS, target: { kind: 'ids', userIds: ['u1', 'u2', 'u3'] } });
    mocks.repo.findById.mockResolvedValue(approvalOf({ paramsJson: tampered }));
    await expect(approveApproval(fullAdmin(APPROVER), ID)).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.repo.claim).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('answers 409 and runs nothing when the params change between the check and the claim', async () => {
    const changed = approvalOf({ status: 'executing', paramsJson: canonicalApprovalJson({ other: true }) });
    mocks.repo.claim.mockResolvedValue(changed);
    await expect(approveApproval(fullAdmin(APPROVER), ID)).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.repo.finish).toHaveBeenCalledWith(ID, 'executing', 'failed', expect.anything());
  });

  it('answers 409 when another approver claimed it first', async () => {
    mocks.repo.claim.mockResolvedValue(null);
    await expect(approveApproval(fullAdmin(APPROVER), ID)).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('answers 409 for a record already decided', async () => {
    mocks.repo.findById.mockResolvedValue(approvalOf({ status: 'executed' }));
    await expect(approveApproval(fullAdmin(APPROVER), ID)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('marks the record failed and rethrows when the executor throws', async () => {
    mocks.execute.mockRejectedValue(new Error('cohort changed'));
    await expect(approveApproval(fullAdmin(APPROVER), ID)).rejects.toThrow('cohort changed');
    expect(mocks.repo.finish).toHaveBeenCalledWith(ID, 'executing', 'failed', { error: 'cohort changed' });
    expect(auditActions()).toEqual(['admin.approval.approved', 'admin.approval.failed']);
  });

  it('rethrows the executor error when marking failed and the failed audit both throw', async () => {
    mocks.execute.mockRejectedValue(new Error('cohort changed'));
    mocks.repo.finish.mockRejectedValueOnce(new Error('db down'));
    mocks.record.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('audit down'));
    const error = vi.fn();
    const req = Object.assign(fullAdmin(APPROVER), { logger: { error } });
    await expect(approveApproval(req, ID)).rejects.toThrow('cohort changed');
    expect(error).toHaveBeenCalledWith('[ADMIN_APPROVAL_MARK_FAILED_FAILED]', expect.anything());
    expect(error).toHaveBeenCalledWith('[ADMIN_APPROVAL_FAILED_AUDIT_FAILED]', expect.anything());
  });

  it('rethrows the approved audit error when its rollback also fails', async () => {
    mocks.record.mockRejectedValueOnce(new Error('audit down'));
    mocks.repo.finish.mockRejectedValueOnce(new Error('db down'));
    const error = vi.fn();
    const req = Object.assign(fullAdmin(APPROVER), { logger: { error } });
    await expect(approveApproval(req, ID)).rejects.toThrow('audit down');
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('[ADMIN_APPROVAL_APPROVE_ROLLBACK_FAILED]', expect.anything());
  });

  it('answers 410 when a concurrent reader expired the record before the claim', async () => {
    mocks.repo.findById.mockResolvedValueOnce(approvalOf()).mockResolvedValueOnce(approvalOf({ status: 'expired' }));
    mocks.repo.claim.mockResolvedValueOnce(null);
    await expect(approveApproval(fullAdmin(APPROVER), ID)).rejects.toMatchObject({ statusCode: 410 });
  });

  it('answers 409 naming the status when another admin won the claim', async () => {
    mocks.repo.findById.mockResolvedValueOnce(approvalOf()).mockResolvedValueOnce(approvalOf({ status: 'executing' }));
    mocks.repo.claim.mockResolvedValueOnce(null);
    await expect(approveApproval(fullAdmin(APPROVER), ID)).rejects.toMatchObject({
      statusCode: 409,
      message: 'This request is already executing.',
    });
  });

  it('still answers 410 when closing an expired record fails', async () => {
    mocks.repo.findById.mockResolvedValue(approvalOf({ expiresAt: new Date(Date.now() - 1) }));
    mocks.repo.finish.mockRejectedValueOnce(new Error('db down'));
    const req = Object.assign(fullAdmin(APPROVER), { logger: { error: vi.fn() } });
    await expect(approveApproval(req, ID)).rejects.toMatchObject({ statusCode: 410 });
  });

  it('still succeeds, and records no failure, when marking the record executed throws', async () => {
    mocks.repo.finish.mockRejectedValueOnce(new Error('db down'));
    const error = vi.fn();
    const req = { user: { id: APPROVER, name: APPROVER, isAdmin: true }, logger: { error } } as unknown as Request;
    const outcome = await approveApproval(req, ID);
    expect(outcome.result).toEqual({ updated: 2 });
    expect(mocks.repo.finish).not.toHaveBeenCalledWith(ID, 'executing', 'failed', expect.anything());
    expect(auditActions()).not.toContain('admin.approval.failed');
    expect(auditActions()).toContain('admin.approval.executed');
    expect(error).toHaveBeenCalledWith('[ADMIN_APPROVAL_FINISH_FAILED]', expect.anything());
  });

  it('still succeeds, and records no failure, when the executed audit write throws', async () => {
    mocks.record.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('audit down'));
    const error = vi.fn();
    const req = { user: { id: APPROVER, name: APPROVER, isAdmin: true }, logger: { error } } as unknown as Request;
    const outcome = await approveApproval(req, ID);
    expect(outcome.approval.status).toBe('executed');
    expect(outcome.result).toEqual({ updated: 2 });
    expect(mocks.repo.finish).not.toHaveBeenCalledWith(ID, 'executing', 'failed', expect.anything());
    expect(auditActions()).not.toContain('admin.approval.failed');
    expect(error).toHaveBeenCalledWith('[ADMIN_APPROVAL_EXECUTED_AUDIT_FAILED]', expect.anything());
  });

  it('only unlocks impersonation of an admin, never running it for the approver', async () => {
    mocks.repo.findById.mockResolvedValue(approvalOf({ action: 'user.impersonate_admin' }));
    await approveApproval(fullAdmin(APPROVER), ID);
    expect(mocks.repo.claim).toHaveBeenCalledWith(ID, 'pending', 'approved', expect.anything(), expect.anything());
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('answers 404 for a malformed or unknown id without a lookup', async () => {
    await expect(approveApproval(fullAdmin(APPROVER), 'nope')).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.repo.findById).not.toHaveBeenCalled();
    mocks.repo.findById.mockResolvedValue(null);
    await expect(approveApproval(fullAdmin(APPROVER), ID)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('rejectApproval', () => {
  it('lets the requester withdraw their own request', async () => {
    const rejected = await rejectApproval(fullAdmin(REQUESTER), ID, 'not needed');
    expect(rejected.status).toBe('rejected');
    expect(auditActions()).toEqual(['admin.approval.rejected']);
  });

  it('refuses a delegated admin without the record permission', async () => {
    await expect(
      rejectApproval(reqAs({ id: APPROVER, adminPermissions: ['support:read'] }), ID, 'no')
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('puts the request back to pending and rethrows when the rejected audit write fails', async () => {
    mocks.record.mockRejectedValueOnce(new Error('audit down'));
    await expect(rejectApproval(fullAdmin(APPROVER), ID, 'no')).rejects.toThrow('audit down');
    expect(mocks.repo.finish).toHaveBeenCalledWith(ID, 'rejected', 'pending', {
      decidedBy: undefined,
      decidedAt: undefined,
      decisionReason: undefined,
    });
  });

  it('rethrows the audit error, not the rollback error, when the rollback also fails', async () => {
    mocks.record.mockRejectedValueOnce(new Error('audit down'));
    mocks.repo.finish.mockRejectedValueOnce(new Error('db down'));
    const error = vi.fn();
    const req = Object.assign(fullAdmin(APPROVER), { logger: { error } });
    await expect(rejectApproval(req, ID, 'no')).rejects.toThrow('audit down');
    expect(error).toHaveBeenCalledWith('[ADMIN_APPROVAL_REJECT_ROLLBACK_FAILED]', expect.anything());
  });
});

describe('redeemApproval', () => {
  const approved = () => approvalOf({ action: 'user.impersonate_admin', status: 'approved' });

  it('lets only the requester redeem, with the approved params', async () => {
    mocks.repo.findById.mockResolvedValue(approved());
    await expect(redeemApproval(fullAdmin(APPROVER), ID, 'user.impersonate_admin', PARAMS)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(
      redeemApproval(fullAdmin(REQUESTER), ID, 'user.impersonate_admin', { targetUserId: 'other' })
    ).rejects.toMatchObject({ statusCode: 409 });
    await redeemApproval(fullAdmin(REQUESTER), ID, 'user.impersonate_admin', PARAMS);
    expect(mocks.repo.claim).toHaveBeenCalledWith(
      ID,
      'approved',
      'executed',
      expect.objectContaining({ requestedBy: REQUESTER }),
      expect.anything()
    );
  });

  it('refuses another admin impersonated by the requester, or acting as them', async () => {
    mocks.repo.findById.mockResolvedValue(approved());
    await expect(
      redeemApproval(fullAdmin(APPROVER, { impersonatedBy: REQUESTER }), ID, 'user.impersonate_admin', PARAMS)
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      redeemApproval(fullAdmin('dddddddddddddddddddddddd'), ID, 'user.impersonate_admin', PARAMS)
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.repo.claim).not.toHaveBeenCalled();
    expect(auditActions()).toEqual([]);
  });

  it('answers 409 while still pending and 409 once used', async () => {
    await expect(redeemApproval(fullAdmin(REQUESTER), ID, 'users.bulk', PARAMS)).rejects.toMatchObject({
      statusCode: 409,
    });
    mocks.repo.findById.mockResolvedValue(approved());
    mocks.repo.claim.mockResolvedValue(null);
    await expect(redeemApproval(fullAdmin(REQUESTER), ID, 'user.impersonate_admin', PARAMS)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe('listApprovals', () => {
  it('reports expiry, stalls and whether the caller may decide each row', async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000);
    mocks.repo.list.mockResolvedValue([
      approvalOf({ id: '1' }),
      approvalOf({ id: '2', expiresAt: new Date(Date.now() - 1) }),
      approvalOf({ id: '3', status: 'executing', decidedAt: old }),
      approvalOf({ id: '4', requestedBy: { id: APPROVER, name: 'B', email: '', selfIds: [APPROVER] } }),
    ]);
    const rows = await listApprovals(fullAdmin(APPROVER), {});
    expect(rows.map(({ id, status, stalled, canDecide }) => ({ id, status, stalled, canDecide }))).toEqual([
      { id: '1', status: 'pending', stalled: false, canDecide: true },
      { id: '2', status: 'expired', stalled: false, canDecide: false },
      { id: '3', status: 'executing', stalled: true, canDecide: false },
      { id: '4', status: 'pending', stalled: false, canDecide: false },
    ]);
    expect(rows[0]).not.toHaveProperty('paramsJson');
    expect(rows[0]?.params).toEqual(PARAMS);
  });

  it('withholds params from an admin who neither requested nor may decide the row', async () => {
    mocks.repo.list.mockResolvedValue([
      approvalOf({ id: '1' }),
      approvalOf({ id: '2', requiresFullAdmin: true }),
      approvalOf({ id: '3', requiredPermission: 'support:read' }),
    ]);
    const viewer = reqAs({ id: APPROVER, adminPermissions: ['support:read', 'users:moderate'] });
    const rows = await listApprovals(viewer, {});
    expect(rows.map(({ id, params }) => ({ id, params }))).toEqual([
      { id: '1', params: PARAMS },
      { id: '2', params: null },
      { id: '3', params: PARAMS },
    ]);
    const requester = await listApprovals(reqAs({ id: REQUESTER, adminPermissions: ['support:read'] }), {});
    expect(requester.map(row => row.params)).toEqual([PARAMS, PARAMS, PARAMS]);
    const reader = await listApprovals(reqAs({ id: APPROVER, adminPermissions: ['support:read'] }), {});
    expect(reader.map(row => row.params)).toEqual([null, null, PARAMS]);
  });

  it('leaves out the decision reason, result and error on rows it withholds params from', async () => {
    const decided = { decisionReason: 'looks fine', result: { updated: 2 }, error: 'boom' };
    mocks.repo.list.mockResolvedValue([
      approvalOf({ id: '1', ...decided }),
      approvalOf({ id: '3', requiredPermission: 'support:read', ...decided }),
    ]);
    const reader = await listApprovals(reqAs({ id: APPROVER, adminPermissions: ['support:read'] }), {});
    expect(reader[0]).not.toHaveProperty('decisionReason');
    expect(reader[0]).not.toHaveProperty('result');
    expect(reader[0]).not.toHaveProperty('error');
    expect(reader[1]).toMatchObject(decided);
  });

  it('cuts a withheld row down to its id, action, status, dates and flags', async () => {
    const decidedAt = new Date();
    mocks.repo.list.mockResolvedValue([
      approvalOf({ id: '1', status: 'rejected', decidedBy: { id: REQUESTER, name: 'Ada' }, decidedAt }),
      approvalOf({ id: '3', requiredPermission: 'support:read' }),
    ]);
    const reader = await listApprovals(reqAs({ id: APPROVER, adminPermissions: ['support:read'] }), {});
    expect(Object.keys(reader[0] ?? {}).sort()).toEqual(
      ['action', 'canDecide', 'createdAt', 'expiresAt', 'id', 'params', 'reason', 'stalled', 'status', 'summary'].sort()
    );
    expect(reader[0]).toMatchObject({ id: '1', status: 'rejected', summary: null, reason: null, params: null });
    expect(reader[1]).toMatchObject({
      requestedBy: { id: REQUESTER, name: 'Ada', email: 'ada@example.com' },
      requiredPermission: 'support:read',
      requiresFullAdmin: false,
    });
  });

  it('withholds summary and reason exactly where it withholds params', async () => {
    mocks.repo.list.mockResolvedValue([
      approvalOf({ id: '1' }),
      approvalOf({ id: '2', requiresFullAdmin: true }),
      approvalOf({ id: '3', requiredPermission: 'support:read' }),
    ]);
    const reader = await listApprovals(reqAs({ id: APPROVER, adminPermissions: ['support:read'] }), {});
    expect(reader.map(({ id, summary, reason }) => ({ id, summary, reason }))).toEqual([
      { id: '1', summary: null, reason: null },
      { id: '2', summary: null, reason: null },
      { id: '3', summary: 'Suspend 2 users', reason: 'spam wave' },
    ]);
    const requester = await listApprovals(reqAs({ id: REQUESTER, adminPermissions: ['support:read'] }), {});
    expect(requester.map(row => row.summary)).toEqual(['Suspend 2 users', 'Suspend 2 users', 'Suspend 2 users']);
  });
});
