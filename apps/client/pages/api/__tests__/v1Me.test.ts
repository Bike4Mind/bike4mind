// @vitest-environment node
/**
 * Route tests for `GET /api/v1/me`.
 *
 * `baseApi` is stubbed (no DB connect, no auth chain) but `nextRouteForContract` is
 * NOT, so the contract's own response drift check runs for real: a body that stops
 * matching the published schema shows up here. The stub also captures the options
 * the adapter derives from the contract, which is how the scope gate is asserted -
 * enforcement itself lives in apiKeyAuth and is tested there.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope, MeResponseSchema } from '@bike4mind/common';

const { mockResolvePlan, mockEntitlements, mockFindActive, mockMembership, mockPlanByPriceId, baseApiOptions } =
  vi.hoisted(() => ({
    mockResolvePlan: vi.fn(),
    mockEntitlements: vi.fn(),
    mockFindActive: vi.fn(),
    mockMembership: vi.fn(),
    mockPlanByPriceId: vi.fn(),
    baseApiOptions: [] as unknown[],
  }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    baseApiOptions.push(options);
    const compose =
      (...handlers: ((req: unknown, res: unknown, next: () => void) => unknown)[]) =>
      async (req: unknown, res: unknown) => {
        for (const handler of handlers) {
          let advanced = false;
          await handler(req, res, () => {
            advanced = true;
          });
          if (!advanced) return;
        }
      };
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.get = compose;
    return chain;
  },
}));

vi.mock('@server/entitlements', () => ({
  getUserEntitlements: mockEntitlements,
  toEntitlementUser: (user: {
    id: string;
    tags?: string[];
    isAdmin?: boolean;
    email?: string;
    emailVerified?: boolean;
  }) => ({
    id: user.id,
    tags: user.tags,
    isAdmin: user.isAdmin,
    email: user.email,
    emailVerified: user.emailVerified,
  }),
}));
vi.mock('@server/me/resolveCallerPlan', () => ({ resolveCallerPlan: mockResolvePlan }));
vi.mock('@server/entitlements/activeSubscriptions', () => ({ getActiveSubscriptionsForUser: mockFindActive }));
vi.mock('@server/dataLakes/requestMembership', () => ({ getRequestMembershipOrgIds: mockMembership }));
vi.mock('@client/lib/userSubscriptions/utils', () => ({ getEntitlingPlanByPriceId: mockPlanByPriceId }));

const { default: handler } = await import('@pages/api/v1/me');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const caller = {
  id: 'u1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  emailVerified: true,
  tags: ['early-adopter'],
  isAdmin: false,
  currentCredits: 1234,
};

function get(query: Record<string, unknown> = {}) {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, { user: caller, logger });
  return { req, res };
}

async function run(req: unknown, res: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (handler as any)(req, res);
}

const ACTIVE = [{ priceId: 'price_pro', periodEndsAt: new Date('2026-10-18T00:00:00.000Z') }];

beforeEach(() => {
  vi.clearAllMocks();
  mockFindActive.mockResolvedValue(ACTIVE);
  mockMembership.mockResolvedValue([]);
  mockResolvePlan.mockReturnValue({
    tier: 'basic',
    subscription: {
      plan_name: 'Professional',
      price_id: 'price_pro',
      interval: 'monthly',
      current_period_ends_at: '2026-10-18T00:00:00.000Z',
    },
  });
  mockEntitlements.mockResolvedValue(['base']);
});

describe('GET /api/v1/me', () => {
  it('returns the caller matching the published schema', async () => {
    const { req, res } = get();

    await run(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(MeResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      id: 'u1',
      name: 'Ada Lovelace',
      tier: 'basic',
      subscription: {
        plan_name: 'Professional',
        price_id: 'price_pro',
        interval: 'monthly',
        current_period_ends_at: '2026-10-18T00:00:00.000Z',
      },
      credits: { balance: 1234 },
      entitlements: ['base'],
    });
  });

  it('publishes no email, tags, or admin flag', async () => {
    const { req, res } = get();

    await run(req, res);

    expect(Object.keys(res._getJSONData()).sort()).toEqual([
      'credits',
      'entitlements',
      'id',
      'name',
      'subscription',
      'tier',
    ]);
  });

  it('marks the response private and uncacheable', async () => {
    const { req, res } = get();

    await run(req, res);

    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });

  it('ignores a caller-supplied subject and reads only the credential holder', async () => {
    const { req, res } = get({ userId: 'someone-else', ownerId: 'someone-else', id: 'someone-else' });

    await run(req, res);

    expect(mockFindActive).toHaveBeenCalledWith('u1', { membershipOrgIds: [] });
    expect(mockEntitlements).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), ACTIVE);
    expect(res._getJSONData().id).toBe('u1');
  });

  it('derives tier and entitlements from one snapshot subscription read', async () => {
    const { req, res } = get();

    await run(req, res);

    expect(mockFindActive).toHaveBeenCalledTimes(1);
    expect(mockResolvePlan).toHaveBeenCalledWith(ACTIVE);
    expect(mockEntitlements).toHaveBeenCalledWith(expect.anything(), ACTIVE);
  });

  it('/me reports the org plan for a seat member', async () => {
    const { resolveCallerPlan } =
      await vi.importActual<typeof import('@server/me/resolveCallerPlan')>('@server/me/resolveCallerPlan');
    mockResolvePlan.mockImplementation(resolveCallerPlan);
    mockPlanByPriceId.mockImplementation((priceId: string) =>
      priceId === 'price_team' ? { priceId, name: 'Team', interval: 'monthly', tier: 2 } : undefined
    );
    mockMembership.mockResolvedValue(['org1']);
    const seatRows = [{ priceId: 'price_team', periodEndsAt: new Date('2026-11-01T00:00:00.000Z') }];
    mockFindActive.mockResolvedValue(seatRows);
    const { req, res } = get();

    await run(req, res);

    expect(mockFindActive).toHaveBeenCalledWith('u1', { membershipOrgIds: ['org1'] });
    expect(mockMembership).toHaveBeenCalledWith(req);
    expect(mockEntitlements).toHaveBeenCalledWith(expect.anything(), seatRows);
    const body = res._getJSONData();
    expect(MeResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      tier: 'pro',
      subscription: {
        plan_name: 'Team',
        price_id: 'price_team',
        interval: 'monthly',
        current_period_ends_at: '2026-11-01T00:00:00.000Z',
      },
    });
  });

  // The route adds two reads that were not here before (membership, org subscriptions). A
  // "best-effort" catch that swallowed either would report a seat member as free with no
  // error; the real `baseApi` `onError` turns the rejection below into the 500 envelope.
  it('propagates a failed membership read instead of reporting a tier', async () => {
    mockMembership.mockRejectedValue(new Error('mongo unavailable'));
    const { req, res } = get();

    await expect(run(req, res)).rejects.toThrow('mongo unavailable');
  });

  it('propagates a failed subscription read instead of reporting a tier', async () => {
    mockFindActive.mockRejectedValue(new Error('mongo unavailable'));
    const { req, res } = get();

    await expect(run(req, res)).rejects.toThrow('mongo unavailable');
  });

  it('gates the route on me:read, so an under-scoped key never reaches the handler', async () => {
    expect(baseApiOptions[0]).toMatchObject({
      auth: true,
      requiredScopes: [ApiKeyScope.ME_READ],
      exemptReadsFromDailyRateLimit: true,
    });
  });
});
