import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'POST']?.(req, res),
      {
        use: () => chain,
        post: (fn: (req: unknown, res: unknown) => unknown) => ((h.POST = fn), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

vi.mock('@server/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

const mockOrgCreate = vi.fn();
const mockAddCredits = vi.fn();
vi.mock('@bike4mind/services', () => ({
  organizationService: { create: (...a: unknown[]) => mockOrgCreate(...a) },
  creditService: { addCredits: (...a: unknown[]) => mockAddCredits(...a) },
}));

let inTransaction = false;
let insideTransactionAtAudit: boolean | undefined;
const mockUserFindById = vi.fn();
vi.mock('@bike4mind/database', () => ({
  creditLotRepository: {},
  creditTransactionRepository: {},
  organizationRepository: {},
  userRepository: { findById: (...a: unknown[]) => mockUserFindById(...a) },
  withTransaction: async (fn: (session: unknown) => Promise<unknown>) => {
    inTransaction = true;
    try {
      return await fn(undefined);
    } finally {
      inTransaction = false;
    }
  },
}));

const mockSubCreate = vi.fn();
const mockFindUserSub = vi.fn();
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: {
    create: (...a: unknown[]) => mockSubCreate(...a),
    findByPriceIdAndOwner: vi.fn().mockResolvedValue(null),
    findUserSubscriptionByPriceId: (...a: unknown[]) => mockFindUserSub(...a),
  },
}));

vi.mock('@server/services/teamPlanSettings', () => ({
  getTeamPlanSettings: vi.fn(async () => ({ minSeats: 3, maxSeats: 8, creditsPerSeat: 1000 })),
}));
vi.mock('@server/websocket/utils', () => ({ sendToClient: vi.fn() }));
vi.mock('@server/utils/adminAudit', () => ({
  recordAdminActionFromRequest: vi.fn(async () => {
    insideTransactionAtAudit = inTransaction;
    return null;
  }),
}));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'ws-endpoint' } } }));

import { SUBSCRIPTION_PLANS } from '@client/lib/userSubscriptions/constants';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import handler from '../grant-subscription';

function call(seats: number) {
  const { req, res } = createMocks({
    method: 'POST',
    query: { userId: 'user-1' },
    body: { subscriptionType: 'team', organizationName: 'Acme', seats },
  });
  (req as unknown as { user: { isAdmin: boolean; id: string } }).user = { isAdmin: true, id: 'admin-1' };
  (req as unknown as { logger: unknown }).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { res, run: () => (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res) };
}

describe('POST /api/admin/users/[userId]/grant-subscription - team seat bounds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserFindById.mockResolvedValue({ id: 'user-1', email: 'u@example.com' });
    mockOrgCreate.mockResolvedValue({ id: 'org-1', name: 'Acme' });
    mockSubCreate.mockResolvedValue({ id: 'sub-1' });
  });

  it('grants a team within the configured range at the configured credits per seat', async () => {
    const { res, run } = call(5);
    await run();
    expect(mockOrgCreate).toHaveBeenCalled();
    expect(mockAddCredits).toHaveBeenCalledWith(expect.objectContaining({ credits: 5 * 1000 }), expect.anything());
    expect(res._getJSONData()).toMatchObject({ seats: 5, credits: 5 * 1000 });
  });

  it('records user.subscription.granted against the user for a team grant, inside the transaction', async () => {
    const { run } = call(5);
    await run();
    expect(insideTransactionAtAudit).toBe(true);
    expect(recordAdminActionFromRequest).toHaveBeenCalledTimes(1);
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.subscription.granted',
        target: expect.objectContaining({ kind: 'user', id: 'user-1' }),
        organizationId: 'org-1',
      })
    );
  });

  it.each([
    ['above the configured ceiling', 9, /Seats cannot exceed 8/],
    ['below the configured floor', 2, /at least 3 seats/],
  ])('rejects a seat count %s before creating anything', async (_label, seats, message) => {
    const { run } = call(seats);
    await expect(run()).rejects.toThrow(message);
    expect(mockOrgCreate).not.toHaveBeenCalled();
    expect(mockAddCredits).not.toHaveBeenCalled();
  });

  it('rejects a fractional seat count', async () => {
    const { run } = call(4.5);
    await expect(run()).rejects.toThrow();
    expect(mockOrgCreate).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/users/[userId]/grant-subscription - individual', () => {
  const plan = SUBSCRIPTION_PLANS[0];

  function callIndividual(priceId: string) {
    const { req, res } = createMocks({
      method: 'POST',
      query: { userId: 'user-1' },
      body: { subscriptionType: 'individual', priceId, durationMonths: 2 },
    });
    (req as unknown as { user: { isAdmin: boolean; id: string } }).user = { isAdmin: true, id: 'admin-1' };
    (req as unknown as { logger: unknown }).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return { res, run: () => (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res) };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockUserFindById.mockResolvedValue({ id: 'user-1', email: 'u@example.com' });
    mockSubCreate.mockResolvedValue({ id: 'sub-1' });
    mockFindUserSub.mockResolvedValue(null);
  });

  it('creates an admin-grant row granted by the admin and adds plan credits times months', async () => {
    const { res, run } = callIndividual(plan.priceId);
    await run();

    expect(mockSubCreate).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'user-1', priceId: plan.priceId, grantedBy: 'admin-1', quantity: 1 })
    );
    expect(mockAddCredits).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'user-1', credits: plan.credits * 2 }),
      expect.anything()
    );
    expect(res._getJSONData()).toMatchObject({ success: true, credits: plan.credits * 2 });
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.subscription.granted',
        target: expect.objectContaining({ kind: 'user', id: 'user-1' }),
      })
    );
  });

  it('rejects when the user already has an active subscription for the plan', async () => {
    mockFindUserSub.mockResolvedValue({ status: 'active' });
    const { run } = callIndividual(plan.priceId);

    await expect(run()).rejects.toThrow('User already has an active subscription for this plan');
    expect(mockSubCreate).not.toHaveBeenCalled();
    expect(mockAddCredits).not.toHaveBeenCalled();
  });

  it('rejects an unknown plan', async () => {
    const { run } = callIndividual('price_nope');

    await expect(run()).rejects.toThrow('Invalid subscription plan');
    expect(mockSubCreate).not.toHaveBeenCalled();
  });
});
