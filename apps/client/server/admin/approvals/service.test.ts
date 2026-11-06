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
    });
    const stored = mocks.repo.create.mock.calls[0]?.[0];
    expect(stored.paramsJson).toBe(canonicalApprovalJson(PARAMS));
    expect(stored.paramsHash).toBe(approvalParamsHash(stored.paramsJson));
    expect(stored.requestedBy.selfIds).toEqual([REQUESTER, 'dddddddddddddddddddddddd']);
    expect(body).toMatchObject({ approvalId: ID, status: 'pending' });
    expect(auditActions()).toEqual(['admin.approval.requested']);
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
});
