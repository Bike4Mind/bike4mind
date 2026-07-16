import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * /api/users/[id]/organization returns an org document (billing + member data),
 * so only the user themselves or an admin may read it. Prove the gate rejects a
 * cross-user read before hitting the database.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
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
vi.mock('@bike4mind/database', () => ({ User: { findById } }));

import '@pages/api/users/[id]/organization';

function mocks(user: unknown, id: string) {
  const { req, res } = createMocks({ method: 'GET', query: { id } });
  (req as any).user = user;
  return { req, res };
}

describe('GET /api/users/[id]/organization - ownership gate', () => {
  beforeEach(() => findById.mockClear());

  it("rejects reading another user's org without querying the DB", async () => {
    const { req, res } = mocks({ id: 'me', isAdmin: false }, 'someone-else');
    await expect(mockRefs.getHandler!(req, res)).rejects.toThrow(/not authorized/i);
    expect(findById).not.toHaveBeenCalled();
  });

  it('allows a user to read their own org', async () => {
    const { req, res } = mocks({ id: 'me', isAdmin: false }, 'me');
    await mockRefs.getHandler!(req, res);
    expect(findById).toHaveBeenCalledWith('me');
    expect(res._getStatusCode()).toBe(200);
  });

  it('strips billing identifiers when the caller is a member (not owner) of their org', async () => {
    const { req, res } = mocks({ id: 'me', isAdmin: false }, 'me');
    await mockRefs.getHandler!(req, res);
    const body = res._getJSONData();
    expect(body.name).toBe('Acme');
    expect('stripeCustomerId' in body).toBe(false);
    expect('billingContact' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('cus_SECRET');
  });

  it("allows an admin to read any user's org", async () => {
    const { req, res } = mocks({ id: 'admin1', isAdmin: true }, 'someone-else');
    await mockRefs.getHandler!(req, res);
    expect(findById).toHaveBeenCalledWith('someone-else');
  });
});
