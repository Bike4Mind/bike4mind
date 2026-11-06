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
  scheduleAccountDeletion: h.core,
  clearAccountDeletion: vi.fn(),
}));

await import('../schedule-deletion');

const REASON = 'Request sent from the email on file';
const RECEIVED = '2026-11-01';

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

const scheduledFor = new Date('2026-11-20T00:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
  h.deny.mockRejectedValue(Object.assign(new Error('self'), { statusCode: 403 }));
  h.findById.mockResolvedValue({ id: 'user-1', username: 'u', email: 'a@customer.example' });
  h.core.mockImplementation(async (_req: unknown, input: { recordInTransaction: (d: unknown) => Promise<void> }) => {
    const deletion = { requestedAt: new Date(RECEIVED), scheduledFor, source: 'support' };
    await input.recordInTransaction(deletion);
    return { deletion, subscriptions: { canceled: [{}, {}] } };
  });
});

describe('POST /api/admin/users/[userId]/schedule-deletion', () => {
  it('is gated on users:delete', () => {
    expect(h.options).toMatchObject({ auth: 'jwtOnly', allowedMethods: ['POST'] });
    expect(h.guard).toBeTruthy();
  });

  it('schedules a support deletion, audits it in the same call, and answers 202', async () => {
    const res = await call({ receivedAt: RECEIVED, reason: REASON });

    expect(h.core).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'user-1',
        source: 'support',
        requestedAt: new Date(RECEIVED),
        actorUserId: 'admin-1',
      })
    );
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.deletion.scheduled',
        reason: REASON,
        target: expect.objectContaining({ kind: 'user', id: 'user-1' }),
        details: {
          receivedAt: new Date(RECEIVED).toISOString(),
          scheduledFor: scheduledFor.toISOString(),
          source: 'support',
        },
      })
    );
    expect(res._getStatusCode()).toBe(202);
    expect(res._getJSONData()).toMatchObject({ deletion: { source: 'support' }, canceledSubscriptions: 2 });
  });

  it.each([
    ['a missing reason', { receivedAt: RECEIVED }],
    ['a missing date', { reason: REASON }],
    ['an unparsable date', { receivedAt: 'last week', reason: REASON }],
    ['a future date', { receivedAt: '2999-01-01', reason: REASON }],
  ])('rejects %s with no change', async (_name, body) => {
    await expect(call(body)).rejects.toMatchObject({ statusCode: 400 });
    expect(h.core).not.toHaveBeenCalled();
  });

  it('refuses a self target with a denied audit entry', async () => {
    await expect(
      call({ receivedAt: RECEIVED, reason: REASON }, { id: 'admin-1', isAdmin: true }, 'admin-1')
    ).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(h.deny).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'user.deletion.denied' }));
    expect(h.core).not.toHaveBeenCalled();
  });

  it('refuses a delegate without users:delete', async () => {
    await expect(
      call({ receivedAt: RECEIVED, reason: REASON }, { isAdmin: false, adminPermissions: ['support:read'] })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(h.core).not.toHaveBeenCalled();
  });

  it('refuses a delegate acting on an account with admin access', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', username: 'boss', isAdmin: true });
    await expect(
      call({ receivedAt: RECEIVED, reason: REASON }, { isAdmin: false, adminPermissions: ['users:delete'] })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(h.core).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown user', async () => {
    h.findById.mockResolvedValue(null);
    await expect(call({ receivedAt: RECEIVED, reason: REASON })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('passes a 409 from the core through', async () => {
    h.core.mockRejectedValue(Object.assign(new Error('already scheduled'), { statusCode: 409 }));
    await expect(call({ receivedAt: RECEIVED, reason: REASON })).rejects.toMatchObject({ statusCode: 409 });
  });
});
