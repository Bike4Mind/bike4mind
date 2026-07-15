import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/users/[id]/organizations lists orgs the caller owns OR is merely a
 * member of (listOwn -> findAllAccessible). Billing identifiers must be stripped
 * per-item from any org the caller does not own; stripeCustomerId is dropped
 * everywhere.
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

const listOwn = vi.hoisted(() =>
  vi.fn(async () => [
    { id: 'owned', userId: 'me', name: 'Mine', billingContact: 'mine@x.com', stripeCustomerId: 'cus_MINE' },
    { id: 'member', userId: 'someoneElse', name: 'Theirs', billingContact: 'theirs@x.com', stripeCustomerId: 'cus_THEIRS' },
  ])
);
vi.mock('@bike4mind/services', () => ({ organizationService: { listOwn } }));
vi.mock('@bike4mind/database', () => ({ organizationRepository: {} }));

import '@pages/api/users/[id]/organizations/index';

describe('GET /api/users/[id]/organizations - safe serialization', () => {
  beforeEach(() => listOwn.mockClear());

  it('keeps billingContact only for orgs the caller owns; never leaks stripeCustomerId', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { id: 'me' } });
    (req as any).user = { id: 'me', isAdmin: false };
    await mockRefs.getHandler!(req, res);

    const body = res._getJSONData();
    const owned = body.find((o: any) => o.id === 'owned');
    const member = body.find((o: any) => o.id === 'member');

    expect(owned.billingContact).toBe('mine@x.com'); // caller owns this one
    expect('billingContact' in member).toBe(false); // caller is only a member here
    expect('stripeCustomerId' in owned).toBe(false);
    expect('stripeCustomerId' in member).toBe(false);
    expect(JSON.stringify(body)).not.toContain('cus_');
  });
});
