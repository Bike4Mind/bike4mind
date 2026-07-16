import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * DELETE /api/organizations/[id]/members (leave) returns the updated org, which
 * is written into the client query cache. It must be routed through
 * toSafeOrganization so a leaving member does not receive billing identifiers.
 */

const mockRefs = vi.hoisted(() => ({
  deleteHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: () => chain,
    post: () => chain,
    delete: (fn: any) => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const leave = vi.hoisted(() =>
  vi.fn(async () => ({
    id: 'org1',
    userId: 'owner1',
    name: 'Acme',
    billingContact: 'billing@acme.com',
    stripeCustomerId: 'cus_SECRET',
  }))
);
vi.mock('@bike4mind/services', () => ({ organizationService: { leave } }));
vi.mock('@bike4mind/database', () => ({ withTransaction: (fn: any) => fn() }));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: {} }));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: {} }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

import '@pages/api/organizations/[id]/members/index';

describe('DELETE /api/organizations/[id]/members (leave) - safe serialization', () => {
  beforeEach(() => leave.mockClear());

  it('strips billing identifiers from the org returned to a leaving member', async () => {
    const { req, res } = createMocks({ method: 'DELETE', query: { id: 'org1' } });
    // A member (not the owner) leaving.
    (req as any).user = { id: 'member2', isAdmin: false };
    (req as any).ability = {};
    await mockRefs.deleteHandler!(req, res);

    const body = res._getJSONData();
    expect(body.name).toBe('Acme');
    expect('stripeCustomerId' in body).toBe(false);
    expect('billingContact' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('cus_SECRET');
  });
});
