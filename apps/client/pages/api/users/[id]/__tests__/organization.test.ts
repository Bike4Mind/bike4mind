import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * /api/users/[id]/organization has two handlers: GET reads the org document (billing + member
 * data), so only the user themselves or an admin may read it and billing identifiers are stripped
 * for non-owners; DELETE clears the active-org pointer (#1428 escape) delegating authz to the
 * service. Both are captured below so neither loses route-level coverage.
 */
const h = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  deleteHandler: null as null | ((req: any, res: any) => unknown),
  userRepository: { update: vi.fn() },
  clearActiveOrganization: vi.fn(async () => undefined),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: any) => {
      h.getHandler = fn;
      return chain;
    },
    delete: (fn: any) => {
      h.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const findById = vi.hoisted(() =>
  vi.fn(() => ({
    populate: () => ({
      select: () =>
        Promise.resolve({
          // Org owned by someone else -> the profile owner is a member, not owner.
          organizationId: {
            id: 'org1',
            userId: 'someoneElse',
            name: 'Acme',
            billingContact: 'billing@acme.com',
            stripeCustomerId: 'cus_SECRET',
          },
        }),
    }),
  }))
);
vi.mock('@bike4mind/database', () => ({ User: { findById }, userRepository: h.userRepository }));
vi.mock('@bike4mind/services', () => ({ organizationService: { clearActiveOrganization: h.clearActiveOrganization } }));

import '@pages/api/users/[id]/organization';

function getMocks(user: unknown, id: string) {
  const { req, res } = createMocks({ method: 'GET', query: { id } });
  (req as any).user = user;
  return { req, res };
}

describe('GET /api/users/[id]/organization - ownership gate', () => {
  beforeEach(() => findById.mockClear());

  it("rejects reading another user's org without querying the DB", async () => {
    const { req, res } = getMocks({ id: 'me', isAdmin: false }, 'someone-else');
    await expect(h.getHandler!(req, res)).rejects.toThrow(/not authorized/i);
    expect(findById).not.toHaveBeenCalled();
  });

  it('allows a user to read their own org', async () => {
    const { req, res } = getMocks({ id: 'me', isAdmin: false }, 'me');
    await h.getHandler!(req, res);
    expect(findById).toHaveBeenCalledWith('me');
    expect(res._getStatusCode()).toBe(200);
  });

  it('strips billing identifiers when the caller is a member (not owner) of their org', async () => {
    const { req, res } = getMocks({ id: 'me', isAdmin: false }, 'me');
    await h.getHandler!(req, res);
    const body = res._getJSONData();
    expect(body.name).toBe('Acme');
    expect('stripeCustomerId' in body).toBe(false);
    expect('billingContact' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('cus_SECRET');
  });

  it("allows an admin to read any user's org", async () => {
    const { req, res } = getMocks({ id: 'admin1', isAdmin: true }, 'someone-else');
    await h.getHandler!(req, res);
    expect(findById).toHaveBeenCalledWith('someone-else');
  });
});

describe('DELETE /api/users/[id]/organization - clear the active-org pointer (#1428 escape)', () => {
  beforeEach(() => h.clearActiveOrganization.mockClear());

  it('delegates to clearActiveOrganization with the caller and target userId, then 204s', async () => {
    const { req, res } = createMocks({ method: 'DELETE', query: { id: 'u1' } });
    (req as any).user = { id: 'u1', isAdmin: false };

    await h.deleteHandler!(req, res);

    // authz (self-or-admin) lives in the service; the route just forwards the caller + target.
    expect(h.clearActiveOrganization).toHaveBeenCalledWith(
      { id: 'u1', isAdmin: false },
      { userId: 'u1' },
      { db: { users: h.userRepository } }
    );
    expect(res.statusCode).toBe(204);
  });
});
