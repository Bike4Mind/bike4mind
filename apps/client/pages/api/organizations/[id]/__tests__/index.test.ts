import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/organizations/[id] is access-gated to org members already; this test
 * pins the response SCOPING: stripeCustomerId is dropped for everyone and
 * billingContact only survives for the owner/admin. In-org fields (systemPrompt,
 * userDetails) are preserved so member UIs keep working.
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
    put: () => chain,
    delete: () => chain,
  };
  return { baseApi: () => chain };
});

const get = vi.hoisted(() => vi.fn(async () => ({
  id: 'org1',
  userId: 'owner1',
  name: 'Acme',
  systemPrompt: 'ctx',
  billingContact: 'billing@acme.com',
  stripeCustomerId: 'cus_SECRET',
  userDetails: [{ id: 'owner1', email: 'o@acme.com', name: 'O', usedCredits: 1, lastCreditUsedAt: null }],
})));
vi.mock('@bike4mind/services', () => ({ organizationService: { get } }));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: {} }));
vi.mock('@server/models/Subscription', () => ({ subscriptionRepository: {} }));
vi.mock('@client/lib/subscriptions/types', () => ({ SubscriptionOwnerType: { Organization: 'organization' } }));

import '@pages/api/organizations/[id]/index';

function mocks(user: unknown) {
  const { req, res } = createMocks({ method: 'GET', query: { id: 'org1' } });
  (req as any).user = user;
  return { req, res };
}

describe('GET /api/organizations/[id] - safe serialization', () => {
  beforeEach(() => get.mockClear());

  it('drops billing identifiers for a non-owner, non-admin member but keeps in-org fields', async () => {
    const { req, res } = mocks({ id: 'member2', isAdmin: false });
    await mockRefs.getHandler!(req, res);
    const body = res._getJSONData();
    expect('stripeCustomerId' in body).toBe(false);
    expect('billingContact' in body).toBe(false);
    expect(body.systemPrompt).toBe('ctx');
    expect(Array.isArray(body.userDetails)).toBe(true);
    expect(JSON.stringify(body)).not.toContain('cus_SECRET');
  });

  it('keeps billingContact for the owner (but never stripeCustomerId)', async () => {
    const { req, res } = mocks({ id: 'owner1', isAdmin: false });
    await mockRefs.getHandler!(req, res);
    const body = res._getJSONData();
    expect(body.billingContact).toBe('billing@acme.com');
    expect('stripeCustomerId' in body).toBe(false);
  });
});
