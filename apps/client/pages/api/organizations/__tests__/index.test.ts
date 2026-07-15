import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/organizations must (1) scope non-admins to their OWN orgs so the search
 * cannot enumerate other tenants, and (2) route every result through
 * toSafeOrganization so billing identifiers never reach a non-owner. Admins keep
 * cross-tenant querying (org-management UIs) and see billingContact.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  lastSearchParams: undefined as any,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
    post: () => chain,
  };
  return { baseApi: () => chain };
});

const search = vi.hoisted(() =>
  vi.fn(async () => ({
    data: [{ id: 'org1', userId: 'owner1', name: 'Acme', billingContact: 'billing@acme.com', stripeCustomerId: 'cus_SECRET' }],
    hasMore: false,
    total: 1,
  }))
);
vi.mock('@bike4mind/services', () => ({ organizationService: { search } }));
vi.mock('@bike4mind/database', () => ({ organizationRepository: {} }));

import '@pages/api/organizations/index';

function mocks(user: unknown, query: Record<string, unknown> = {}) {
  const { req, res } = createMocks({ method: 'GET', query });
  (req as any).user = user;
  return { req, res };
}

describe('GET /api/organizations - scoping + safe serialization', () => {
  beforeEach(() => search.mockClear());

  it('forces filters.userId to self for a non-admin', async () => {
    const { req, res } = mocks({ id: 'u1', isAdmin: false });
    await mockRefs.getHandler!(req, res);
    const params = search.mock.calls[0][1];
    expect(params.filters.userId).toBe('u1');
  });

  it('does NOT force a userId filter for an admin', async () => {
    const { req, res } = mocks({ id: 'admin1', isAdmin: true });
    await mockRefs.getHandler!(req, res);
    const params = search.mock.calls[0][1];
    expect(params.filters?.userId).toBeUndefined();
  });

  it('strips stripeCustomerId (always) and billingContact (non-owner non-admin) from results', async () => {
    const { req, res } = mocks({ id: 'u1', isAdmin: false });
    await mockRefs.getHandler!(req, res);
    const body = res._getJSONData();
    expect(body.data[0].name).toBe('Acme');
    expect('stripeCustomerId' in body.data[0]).toBe(false);
    expect('billingContact' in body.data[0]).toBe(false);
    expect(JSON.stringify(body)).not.toContain('cus_SECRET');
  });

  it('keeps billingContact for an admin caller', async () => {
    const { req, res } = mocks({ id: 'admin1', isAdmin: true });
    await mockRefs.getHandler!(req, res);
    const body = res._getJSONData();
    expect(body.data[0].billingContact).toBe('billing@acme.com');
    expect('stripeCustomerId' in body.data[0]).toBe(false);
  });
});
