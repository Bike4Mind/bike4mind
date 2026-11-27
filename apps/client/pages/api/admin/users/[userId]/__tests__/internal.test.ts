import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createMocks } from 'node-mocks-http';
import { ADMIN_AUDIT_CATALOGUE } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: Request, res: Response) => Promise<unknown>),
  guard: null as null | ((req: Request, res: Response, next: () => void) => void),
  options: null as null | Record<string, unknown>,
  findById: vi.fn(),
  update: vi.fn(),
  audit: vi.fn(),
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
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: h.findById, update: h.update },
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
}));
// parseAdminActionReason stays real so the 400s are the route's own.
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>()),
  recordAdminActionFromRequest: h.audit,
}));

await import('../internal');

const REASON = 'Contractor on a personal email';

const call = async (body: unknown, actor: { isAdmin?: boolean; adminPermissions?: string[] } = { isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'POST', body, query: { userId: 'user-1' } });
  const request = Object.assign(req, { user: { id: 'admin-1', ...actor } }) as unknown as Request;
  h.guard!(request, res as unknown as Response, () => {});
  await h.handler!(request, res as unknown as Response);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
  h.findById.mockResolvedValue({ id: 'user-1', username: 'u', email: 'a@customer.example' });
});

describe('POST /api/admin/users/[userId]/internal', () => {
  it('declares first-party JWT-only authentication and only POST', () => {
    expect(h.options).toMatchObject({ auth: 'jwtOnly', allowedMethods: ['POST'] });
  });

  it.each([
    ['an ordinary user', { isAdmin: false }],
    ['a support-only delegate', { isAdmin: false, adminPermissions: ['support:read'] }],
  ])('refuses %s before touching the user', async (_name, actor) => {
    await expect(call({ isInternal: true, reason: REASON }, actor)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.findById).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it('marks an unmarked account and audits the change', async () => {
    const res = await call({ isInternal: true, reason: REASON });

    expect(h.update).toHaveBeenCalledWith({ id: 'user-1', isInternal: true });
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.internal.marked',
        reason: REASON,
        target: expect.objectContaining({ kind: 'user', id: 'user-1' }),
        changes: [{ field: 'isInternal', before: false, after: true }],
      })
    );
    expect(res._getJSONData()).toEqual({ isInternal: true });
  });

  it('unmarks a marked account and audits the change', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', username: 'u', isInternal: true });

    await call({ isInternal: false, reason: REASON });

    expect(h.update).toHaveBeenCalledWith({ id: 'user-1', isInternal: false });
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.internal.unmarked',
        changes: [{ field: 'isInternal', before: true, after: false }],
      })
    );
  });

  it('lets a delegate holding settings:manage mark a customer account', async () => {
    await call({ isInternal: true, reason: REASON }, { isAdmin: false, adminPermissions: ['settings:manage'] });
    expect(h.update).toHaveBeenCalledWith({ id: 'user-1', isInternal: true });
  });

  it('refuses a delegate acting on an account with admin access, with no write and no audit', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', username: 'boss', isAdmin: true });

    await expect(
      call({ isInternal: true, reason: REASON }, { isAdmin: false, adminPermissions: ['settings:manage'] })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('treats a missing flag as unmarked, so unmarking is a no-op', async () => {
    const res = await call({ isInternal: false, reason: REASON });

    expect(h.update).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
    expect(res._getJSONData()).toEqual({ isInternal: false });
  });

  it('answers 404 for an unknown user', async () => {
    h.findById.mockResolvedValue(null);
    await expect(call({ isInternal: true, reason: REASON })).rejects.toMatchObject({ statusCode: 404 });
    expect(h.update).not.toHaveBeenCalled();
  });

  it.each([{}, { isInternal: 'yes' }, null])('rejects an invalid body %j', async body => {
    await expect(call(body)).rejects.toThrow(/invalid request body/i);
    expect(h.update).not.toHaveBeenCalled();
  });

  it.each([
    [{ isInternal: true }, /outdated version/],
    [{ isInternal: true, reason: 'no' }, /at least/i],
  ])('rejects a missing or too-short reason %j with no write and no audit', async (body, message) => {
    await expect(call(body)).rejects.toThrow(message);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('records both directions strictly, so no change commits without its record', () => {
    expect(ADMIN_AUDIT_CATALOGUE['user.internal.marked']).toMatchObject({ write: 'strict' });
    expect(ADMIN_AUDIT_CATALOGUE['user.internal.unmarked']).toMatchObject({ write: 'strict' });
  });
});
