import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: Request, res: Response) => Promise<unknown>),
  guard: null as null | ((req: Request, res: Response, next: () => void) => void),
  options: null as null | Record<string, unknown>,
  findById: vi.fn(),
  audit: vi.fn(),
  core: vi.fn(),
  deny: vi.fn(),
  auditCallsAtCommit: -1,
}));

// adminApi stays real: the permission guard it installs is part of what is under test.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: Record<string, unknown>) => {
    h.options = options;
    const chain = {
      use: (guard: (req: Request, res: Response, next: () => void) => void) => {
        h.guard = guard;
        return chain;
      },
      post: (fn: (req: Request, res: Response) => Promise<unknown>) => {
        h.handler = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({ userRepository: { findById: h.findById } }));
vi.mock('@server/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/utils/adminAudit')>()),
  recordAdminActionFromRequest: h.audit,
  denySelfAdminAction: h.deny,
}));

vi.mock('@server/users/accountDeletion', () => ({
  scheduleAccountDeletion: vi.fn(),
  clearAccountDeletion: h.core,
}));

await import('../cancel-deletion');

const REASON = 'User asked to cancel, identity verified';

const call = async (
  body: unknown,
  actor: { id?: string; isAdmin?: boolean; adminPermissions?: string[] } = { isAdmin: true },
  userId = 'user-1'
) => {
  const { req, res } = createMocks({ method: 'POST', body, query: { userId } });
  const request = Object.assign(req, { user: { id: 'admin-1', ...actor } }) as unknown as Request;
  h.guard!(request, res as unknown as Response, () => {});
  await h.handler!(request, res as unknown as Response);
  return res;
};

const cleared = { requestedAt: new Date('2026-11-01'), scheduledFor: new Date('2026-11-20'), source: 'support' };

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
  h.deny.mockRejectedValue(Object.assign(new Error('self'), { statusCode: 403 }));
  h.findById.mockResolvedValue({ id: 'user-1', username: 'u', email: 'a@customer.example' });
  h.core.mockImplementation(async (_req: unknown, input: { recordInTransaction: (d: unknown) => Promise<void> }) => {
    await input.recordInTransaction(cleared);
    h.auditCallsAtCommit = h.audit.mock.calls.length;
  });
});

describe('POST /api/admin/users/[userId]/cancel-deletion', () => {
  it('clears the deletion, audits before/after, and answers 204', async () => {
    const res = await call({ reason: REASON });

    expect(h.core).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 'user-1', actorUserId: 'admin-1' })
    );
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.deletion.cancelled',
        reason: REASON,
        changes: [{ field: 'deletion', before: cleared, after: null }],
      })
    );
    expect(res._getStatusCode()).toBe(204);
  });

  it('is gated on users:delete', async () => {
    const res = await call({ reason: REASON }, { isAdmin: false, adminPermissions: ['users:delete'] });
    expect(res._getStatusCode()).toBe(204);
    await expect(call({ reason: REASON }, { isAdmin: false, adminPermissions: ['users:write'] })).rejects.toMatchObject(
      {
        statusCode: 403,
      }
    );
  });

  it('refuses a delegate acting on an account with admin access', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', username: 'boss', isAdmin: true });
    await expect(
      call({ reason: REASON }, { isAdmin: false, adminPermissions: ['users:delete'] })
    ).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(h.core).not.toHaveBeenCalled();
  });

  it('writes the audit inside the core callback, before the core commits', async () => {
    await call({ reason: REASON });
    expect(h.auditCallsAtCommit).toBe(1);
  });

  it('fails the request when the audit write fails', async () => {
    h.audit.mockRejectedValue(new Error('audit down'));
    await expect(call({ reason: REASON })).rejects.toThrow('audit down');
  });

  it('denies a self target with an empty body, not a 400', async () => {
    await expect(call({}, { id: 'admin-1', isAdmin: true }, 'admin-1')).rejects.toMatchObject({ statusCode: 403 });
    expect(h.deny).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.deletion.denied',
        attempted: 'user.deletion.cancelled',
        target: expect.objectContaining({ kind: 'user', id: 'admin-1' }),
      })
    );
  });

  it('requires a reason', async () => {
    await expect(call({})).rejects.toMatchObject({ statusCode: 400 });
    expect(h.core).not.toHaveBeenCalled();
  });

  it('refuses a self target and a delegate without users:delete', async () => {
    await expect(call({ reason: REASON }, { id: 'admin-1', isAdmin: true }, 'admin-1')).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(call({ reason: REASON }, { isAdmin: false, adminPermissions: [] })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(h.core).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown user', async () => {
    h.findById.mockResolvedValue(null);
    await expect(call({ reason: REASON })).rejects.toMatchObject({ statusCode: 404 });
  });

  it.each([404, 409])('passes a %i from the core through', async statusCode => {
    h.core.mockRejectedValue(Object.assign(new Error('nope'), { statusCode }));
    await expect(call({ reason: REASON })).rejects.toMatchObject({ statusCode });
  });
});
