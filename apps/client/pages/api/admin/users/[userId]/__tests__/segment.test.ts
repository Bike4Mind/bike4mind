import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createMocks } from 'node-mocks-http';
import { ADMIN_AUDIT_CATALOGUE } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: Request, res: Response) => Promise<unknown>),
  guard: null as null | ((req: Request, res: Response, next: () => void) => void),
  options: null as null | Record<string, unknown>,
  findById: vi.fn(),
  setAccountSegment: vi.fn(),
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
  userRepository: { findById: h.findById, setAccountSegment: h.setAccountSegment },
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>()),
  recordAdminActionFromRequest: h.audit,
}));

await import('../segment');

const REASON = 'Known partner on a personal email';

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

describe('POST /api/admin/users/[userId]/segment', () => {
  it('declares first-party JWT-only authentication and only POST', () => {
    expect(h.options).toMatchObject({ auth: 'jwtOnly', allowedMethods: ['POST'] });
  });

  it('refuses a delegate without settings:manage before touching the user', async () => {
    await expect(
      call({ accountSegment: 'partner', reason: REASON }, { isAdmin: false, adminPermissions: ['support:read'] })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(h.findById).not.toHaveBeenCalled();
    expect(h.setAccountSegment).not.toHaveBeenCalled();
  });

  it('sets partner on a customer account and audits the change', async () => {
    const res = await call({ accountSegment: 'partner', reason: REASON });

    expect(h.setAccountSegment).toHaveBeenCalledWith('user-1', 'partner');
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.segment.changed',
        reason: REASON,
        target: expect.objectContaining({ kind: 'user', id: 'user-1' }),
        changes: [{ field: 'accountSegment', before: 'customer', after: 'partner' }],
      })
    );
    expect(res._getJSONData()).toEqual({ accountSegment: 'partner' });
  });

  it('unsets the field when a partner goes back to customer', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', username: 'u', accountSegment: 'partner' });

    await call({ accountSegment: 'customer', reason: REASON });

    expect(h.setAccountSegment).toHaveBeenCalledWith('user-1', null);
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ changes: [{ field: 'accountSegment', before: 'partner', after: 'customer' }] })
    );
  });

  it.each([
    ['partner', { accountSegment: 'partner' }],
    ['customer', {}],
  ])('treats %s to the same value as a no-op with no write and no audit', async (segment, user) => {
    h.findById.mockResolvedValue({ id: 'user-1', username: 'u', ...user });

    const res = await call({ accountSegment: segment, reason: REASON });

    expect(h.setAccountSegment).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
    expect(res._getJSONData()).toEqual({ accountSegment: segment });
  });

  it('refuses a delegate acting on an account with admin access, with no write and no audit', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', username: 'boss', isAdmin: true });

    await expect(
      call({ accountSegment: 'partner', reason: REASON }, { isAdmin: false, adminPermissions: ['settings:manage'] })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(h.setAccountSegment).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown user', async () => {
    h.findById.mockResolvedValue(null);
    await expect(call({ accountSegment: 'partner', reason: REASON })).rejects.toMatchObject({ statusCode: 404 });
    expect(h.setAccountSegment).not.toHaveBeenCalled();
  });

  it.each([{}, { accountSegment: 'internal' }, { accountSegment: 'vip' }, null])(
    'rejects an invalid body %j with a 400 (internal is only settable through isInternal)',
    async body => {
      await expect(call(body)).rejects.toMatchObject({ statusCode: 400 });
      expect(h.setAccountSegment).not.toHaveBeenCalled();
    }
  );

  it.each([
    [{ accountSegment: 'partner' }, /outdated version/],
    [{ accountSegment: 'partner', reason: 'no' }, /at least/i],
  ])('rejects a missing or too-short reason %j with no write and no audit', async (body, message) => {
    await expect(call(body)).rejects.toThrow(message);
    expect(h.setAccountSegment).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('records the change strictly, so no change commits without its record', () => {
    expect(ADMIN_AUDIT_CATALOGUE['user.segment.changed']).toMatchObject({ write: 'strict' });
  });
});
