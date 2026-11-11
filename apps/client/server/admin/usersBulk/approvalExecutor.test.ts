import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, type AdminApproval } from '@bike4mind/common';
import { AdminSettings } from '@bike4mind/database/infra';

const mockExecute = vi.fn();
const mockFindById = vi.fn();
const mockRequire = vi.fn();

vi.mock('@bike4mind/database', () => ({ userRepository: { findById: (...a: unknown[]) => mockFindById(...a) } }));
vi.mock('@server/middlewares/adminApi', () => ({ requireAdminPermission: (...a: unknown[]) => mockRequire(...a) }));
vi.mock('@server/admin/approvals/auditWriter', () => ({ approvalAuditWriter: vi.fn(() => ({})) }));
vi.mock('./adapters', () => ({ usersBulkExecuteDepsFor: vi.fn(() => ({})) }));
vi.mock('./execute', () => ({ executeAdminUsersBulk: (...a: unknown[]) => mockExecute(...a) }));

import { executeApprovedUsersBulk } from './approvalExecutor';

const ids = ['1'.repeat(24)];
const target = { kind: 'ids', userIds: ids };
const envelope = {
  reason: 'Coordinated signup abuse confirmed',
  idempotencyKey: '3f2b8c1e-5d4a-4b6c-9e7f-1a2b3c4d5e6f',
  expectedCount: 1,
  cohortHash: 'a'.repeat(64),
};
const suspend = { target, action: { type: 'suspend' }, ...envelope };
const contain = { target, action: { type: 'contain', blockEmailDomains: true }, ...envelope };

const approval = { requestedBy: { id: 'req', selfIds: ['req'] } } as unknown as AdminApproval;
const approverReq = (isAdmin: boolean, canSettings = true) =>
  ({
    user: { id: 'apr', isAdmin },
    ability: { can: (_a: string, subject: unknown) => subject !== AdminSettings || canSettings },
    logger: {},
  }) as never;

describe('executeApprovedUsersBulk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequire.mockReset();
    mockExecute.mockResolvedValue({ ok: true });
  });

  it('throws Forbidden when the approver lacks an action permission', async () => {
    mockRequire.mockImplementation(() => {
      throw new ForbiddenError('Missing permission: users:moderate');
    });
    await expect(executeApprovedUsersBulk(suspend, { req: approverReq(false), approval })).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect(mockRequire).toHaveBeenCalledWith(expect.anything(), 'users:moderate');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('checks every permission the action needs', async () => {
    await executeApprovedUsersBulk(contain, { req: approverReq(true), approval });
    expect(mockRequire.mock.calls.map(c => c[1])).toEqual(['users:moderate', 'credits:adjust']);
  });

  it('runs as non-full-admin when a full-admin approves a delegate requester', async () => {
    mockFindById.mockResolvedValue({ id: 'req', isAdmin: false });
    await executeApprovedUsersBulk(suspend, { req: approverReq(true), approval });
    expect(mockExecute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'apr', fullAdmin: false }),
      expect.anything()
    );
  });

  it('runs as full-admin when both approver and requester are full admins', async () => {
    mockFindById.mockResolvedValue({ id: 'req', isAdmin: true });
    await executeApprovedUsersBulk(suspend, { req: approverReq(true), approval });
    expect(mockExecute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fullAdmin: true }),
      expect.anything()
    );
  });

  it('throws Forbidden for a domain-blocking action without admin settings update ability', async () => {
    await expect(executeApprovedUsersBulk(contain, { req: approverReq(true, false), approval })).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
