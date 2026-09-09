import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ZodError } from 'zod';

const mockRefs = vi.hoisted(() => ({
  putHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: () => chain,
    put: (fn: any) => {
      mockRefs.putHandler = fn;
      return chain;
    },
    delete: () => chain,
  };
  return { baseApi: () => chain };
});

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: any) => fn,
}));

const update = vi.hoisted(() => vi.fn(async () => ({ id: 'org1', userId: 'u1', name: 'Acme' })));
vi.mock('@bike4mind/services', () => ({
  organizationService: { update, get: vi.fn() },
}));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: {} }));
vi.mock('@bike4mind/database', () => ({
  partnerSignupRuleRepository: {},
  userRepository: {},
  withTransaction: (fn: any) => fn(),
}));
vi.mock('@bike4mind/database/social', () => ({ groupRepository: {} }));
vi.mock('@bike4mind/common', () => ({ toSafeOrganization: (org: any) => org }));
vi.mock('@server/entitlements/partnerRules', () => ({ invalidatePartnerRuleCache: vi.fn() }));
vi.mock('@server/models/Subscription', () => ({ subscriptionRepository: {} }));
vi.mock('@client/lib/subscriptions/types', () => ({ SubscriptionOwnerType: {} }));

import '@pages/api/organizations/[id]/index';

function makeReq(body: unknown, queryId = 'org-123') {
  const { req, res } = createMocks({ method: 'PUT', query: { id: queryId } });
  (req as any).user = { id: 'u1', isAdmin: false };
  (req as any).ability = null;
  (req as any).body = body;
  return { req, res };
}

describe('PUT /api/organizations/[id] -- Zod validation', () => {
  beforeEach(() => update.mockClear());

  it('accepts a real client payload (name + description)', async () => {
    const { req, res } = makeReq({ name: 'Acme Corp', description: 'We build things' });
    await mockRefs.putHandler!(req, res);
    expect(update).toHaveBeenCalledOnce();
  });

  it('accepts systemPrompt up to 10000 chars', async () => {
    const { req, res } = makeReq({ systemPrompt: 'a'.repeat(100) });
    await mockRefs.putHandler!(req, res);
    expect(update).toHaveBeenCalledOnce();
  });

  it('rejects systemPrompt over 10000 chars', async () => {
    const { req, res } = makeReq({ systemPrompt: 'a'.repeat(10001) });
    await expect(mockRefs.putHandler!(req, res)).rejects.toThrow(ZodError);
    expect(update).not.toHaveBeenCalled();
  });

  it('coerces numeric string currentCredits to a number', async () => {
    const { req, res } = makeReq({ currentCredits: '500' });
    await mockRefs.putHandler!(req, res);
    expect(update).toHaveBeenCalledOnce();
    const calledBody = update.mock.calls[0][1] as any;
    expect(typeof calledBody.currentCredits).toBe('number');
  });

  it('rejects non-numeric currentCredits that coerce to NaN', async () => {
    const { req, res } = makeReq({ currentCredits: 'not-a-number' });
    await expect(mockRefs.putHandler!(req, res)).rejects.toThrow(ZodError);
    expect(update).not.toHaveBeenCalled();
  });

  it('strips unknown keys before they reach the service', async () => {
    const { req, res } = makeReq({ name: 'n', stripeCustomerId: 'cus_EVIL' });
    await mockRefs.putHandler!(req, res);
    const calledBody = update.mock.calls[0][1] as any;
    expect(calledBody).not.toHaveProperty('stripeCustomerId');
  });
});
