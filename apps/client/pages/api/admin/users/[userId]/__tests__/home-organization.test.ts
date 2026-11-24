import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createMocks } from 'node-mocks-http';
import { ADMIN_AUDIT_CATALOGUE } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: Request, res: Response) => Promise<unknown>),
  getHandler: null as null | ((req: Request, res: Response) => Promise<unknown>),
  guard: null as null | ((req: Request, res: Response, next: () => void) => void),
  options: null as null | Record<string, unknown>,
  findUser: vi.fn(),
  findOrg: vi.fn(),
  clear: vi.fn(),
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
      get: (fn: (req: Request, res: Response) => Promise<unknown>) => {
        h.getHandler = fn;
        return chain;
      },
      delete: (fn: (req: Request, res: Response) => Promise<unknown>) => {
        h.handler = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: h.findUser },
  organizationRepository: { findById: h.findOrg },
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/services', () => ({ organizationService: { clearActiveOrganization: h.clear } }));
// parseAdminActionReason stays real so the 400s are the route's own.
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>()),
  recordAdminActionFromRequest: h.audit,
}));

await import('../home-organization');

const REASON = 'Billed to the wrong org';
const ORG_ID = '650000000000000000000aaa';

const call = async (body: unknown, actor: { isAdmin?: boolean; adminPermissions?: string[] } = { isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'DELETE', body, query: { userId: 'user-1' } });
  const request = Object.assign(req, { user: { id: 'admin-1', ...actor } }) as unknown as Request;
  h.guard!(request, res as unknown as Response, () => {});
  await h.handler!(request, res as unknown as Response);
  return res;
};

const read = async (actor: { isAdmin?: boolean; adminPermissions?: string[] } = { isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'GET', query: { userId: 'user-1' } });
  const request = Object.assign(req, { user: { id: 'admin-1', ...actor } }) as unknown as Request;
  h.guard!(request, res as unknown as Response, () => {});
  await h.getHandler!(request, res as unknown as Response);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
  h.clear.mockResolvedValue(undefined);
  h.findUser.mockResolvedValue({ id: 'user-1', username: 'u', email: 'a@customer.example', organizationId: ORG_ID });
  h.findOrg.mockResolvedValue({ id: ORG_ID, name: 'Acme' });
});

describe('DELETE /api/admin/users/[userId]/home-organization', () => {
  it('declares first-party JWT-only authentication and only GET and DELETE', () => {
    expect(h.options).toMatchObject({ auth: 'jwtOnly' });
    expect([...(h.options!.allowedMethods as string[])].sort()).toEqual(['DELETE', 'GET']);
  });

  it.each([
    ['an ordinary user', { isAdmin: false }],
    ['a users:moderate delegate', { isAdmin: false, adminPermissions: ['users:moderate'] }],
  ])('refuses %s before touching the user', async (_name, actor) => {
    await expect(call({ reason: REASON }, actor)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.findUser).not.toHaveBeenCalled();
    expect(h.clear).not.toHaveBeenCalled();
  });

  it('clears the home org and audits it with the org name', async () => {
    const res = await call({ reason: REASON });

    expect(h.clear).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'admin-1' }),
      { userId: 'user-1' },
      expect.anything()
    );
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.home_org.cleared',
        reason: REASON,
        organizationId: ORG_ID,
        target: expect.objectContaining({ kind: 'user', id: 'user-1' }),
        changes: [{ field: 'organizationId', before: ORG_ID, after: null }],
        details: { organizationName: 'Acme' },
      })
    );
    expect(res.statusCode).toBe(204);
  });

  it('falls back to the user id for the audit target of an account with no email or username', async () => {
    h.findUser.mockResolvedValue({ id: 'user-1', organizationId: ORG_ID });

    await call({ reason: REASON });

    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ target: { kind: 'user', id: 'user-1', displayName: 'user-1' } })
    );
  });

  it('still clears a pointer to an org that no longer exists', async () => {
    h.findOrg.mockResolvedValue(null);

    await call({ reason: REASON });

    expect(h.clear).toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ details: undefined }));
  });

  it('is a no-op with no audit entry when there is no home org', async () => {
    h.findUser.mockResolvedValue({ id: 'user-1', username: 'u', organizationId: null });

    const res = await call({ reason: REASON });

    expect(h.clear).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(204);
  });

  it('answers 404 for an unknown user', async () => {
    h.findUser.mockResolvedValue(null);
    await expect(call({ reason: REASON })).rejects.toMatchObject({ statusCode: 404 });
    expect(h.clear).not.toHaveBeenCalled();
  });

  it.each([
    [{}, /outdated version/],
    [{ reason: 'no' }, /at least/i],
  ])('rejects a missing or too-short reason %j with no write and no audit', async (body, message) => {
    await expect(call(body)).rejects.toThrow(message);
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('records the clear strictly, so it never commits without its record', () => {
    expect(ADMIN_AUDIT_CATALOGUE['user.home_org.cleared']).toMatchObject({ write: 'strict' });
  });
});

describe('GET /api/admin/users/[userId]/home-organization', () => {
  it('returns a home org they are a member of', async () => {
    h.findOrg.mockResolvedValue({ id: ORG_ID, name: 'Acme', userId: 'owner-1', users: [{ userId: 'user-1' }] });

    const res = await read();

    expect(res._getJSONData()).toEqual({ organizationId: ORG_ID, organizationName: 'Acme', isMember: true });
  });

  it('returns the raw pointer for an org they left, which the user record serves as null', async () => {
    h.findOrg.mockResolvedValue({ id: ORG_ID, name: 'Acme', userId: 'owner-1', users: [] });

    const res = await read();

    expect(res._getJSONData()).toEqual({ organizationId: ORG_ID, organizationName: 'Acme', isMember: false });
  });

  it('returns the raw pointer with no name for a deleted org', async () => {
    h.findOrg.mockResolvedValue(null);

    const res = await read();

    expect(res._getJSONData()).toEqual({ organizationId: ORG_ID, organizationName: null, isMember: false });
  });

  it('returns no home org without reading an org', async () => {
    h.findUser.mockResolvedValue({ id: 'user-1', username: 'u', organizationId: null });

    const res = await read();

    expect(h.findOrg).not.toHaveBeenCalled();
    expect(res._getJSONData()).toEqual({ organizationId: null, organizationName: null, isMember: false });
  });

  it('refuses a users:moderate delegate before touching the user', async () => {
    await expect(read({ isAdmin: false, adminPermissions: ['users:moderate'] })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(h.findUser).not.toHaveBeenCalled();
  });
});
