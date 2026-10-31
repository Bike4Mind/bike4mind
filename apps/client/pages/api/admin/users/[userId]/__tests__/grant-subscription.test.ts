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

vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

const mockOrgCreate = vi.fn();
const mockAddCredits = vi.fn();
vi.mock('@bike4mind/services', () => ({
  organizationService: { create: (...a: unknown[]) => mockOrgCreate(...a) },
  creditService: { addCreditsWithLedgerRow: (...a: unknown[]) => mockAddCredits(...a) },
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

vi.mock('@bike4mind/server-utils/services/teamPlanSettings', () => ({
  getTeamPlanSettings: vi.fn(async () => ({ minSeats: 3, maxSeats: 8, creditsPerSeat: 1000 })),
}));
vi.mock('@server/websocket/utils', () => ({ sendToClient: vi.fn() }));
// parseAdminActionReason and isSameUserId stay real; the denied helper records, then throws a 403.
vi.mock('@server/utils/adminAudit', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/utils/adminAudit')>();
  const { ForbiddenError } = await import('@bike4mind/common');
  const record = vi.fn(async () => {
    insideTransactionAtAudit = inTransaction;
    return null;
  });
  return {
    ...actual,
    recordAdminActionFromRequest: record,
    denySelfAdminAction: vi.fn(async (req: unknown, { action, attempted, target }: Record<string, unknown>) => {
      await record(req as never, { action, target, details: { attemptedAction: attempted } } as never);
      throw new ForbiddenError('Admins cannot perform this action on their own account.');
    }),
  };
});
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'ws-endpoint' } } }));

import { SUBSCRIPTION_PLANS } from '@client/lib/userSubscriptions/constants';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { sendToClient } from '@server/websocket/utils';
import handler from '../grant-subscription';

const REASON = 'Comped for the design partner pilot';

function call(seats: number) {
  const { req, res } = createMocks({
    method: 'POST',
    query: { userId: 'user-1' },
    body: { subscriptionType: 'team', organizationName: 'Acme', seats, reason: REASON },
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
    mockAddCredits.mockResolvedValue({ creditHolder: { currentCredits: 0 }, creditTransactionId: 'tx-sub-grant' });
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
        reason: REASON,
        details: expect.objectContaining({ subscriptionType: 'team', seats: 5, credits: 5 * 1000 }),
        related: { creditTransactionId: 'tx-sub-grant' },
      })
    );
  });

  it('fails the request without notifying when the strict audit write fails', async () => {
    vi.mocked(recordAdminActionFromRequest).mockRejectedValueOnce(new Error('audit down'));
    const { run } = call(5);

    await expect(run()).rejects.toThrow('audit down');
    expect(sendToClient).not.toHaveBeenCalled();
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
      body: { subscriptionType: 'individual', priceId, durationMonths: 2, reason: REASON },
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
    mockAddCredits.mockResolvedValue({ creditHolder: { currentCredits: 0 }, creditTransactionId: 'tx-sub-grant' });
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
        reason: REASON,
        related: { creditTransactionId: 'tx-sub-grant' },
      })
    );
  });

  it('records the audit inside the grant transaction', async () => {
    const { run } = callIndividual(plan.priceId);
    await run();
    expect(insideTransactionAtAudit).toBe(true);
    expect(recordAdminActionFromRequest).toHaveBeenCalledTimes(1);
  });

  it('fails the request without notifying when the strict audit write fails', async () => {
    vi.mocked(recordAdminActionFromRequest).mockRejectedValueOnce(new Error('audit down'));
    const { run } = callIndividual(plan.priceId);

    await expect(run()).rejects.toThrow('audit down');
    expect(sendToClient).not.toHaveBeenCalled();
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

describe('POST /api/admin/users/[userId]/grant-subscription - reason and self-grant', () => {
  const plan = SUBSCRIPTION_PLANS[0];
  const bodies: Array<[string, Record<string, unknown>]> = [
    ['team', { subscriptionType: 'team', organizationName: 'Acme', seats: 5 }],
    ['individual', { subscriptionType: 'individual', priceId: plan.priceId, durationMonths: 2 }],
  ];

  function callWith(
    body: Record<string, unknown>,
    userId = 'user-1',
    user: Record<string, unknown> = { isAdmin: true, id: 'admin-1', email: 'a@example.com' }
  ) {
    const { req, res } = createMocks({ method: 'POST', query: { userId }, body });
    (req as unknown as { user: unknown }).user = user;
    (req as unknown as { logger: unknown }).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return () => (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockUserFindById.mockResolvedValue({ id: 'user-1', email: 'u@example.com' });
    mockOrgCreate.mockResolvedValue({ id: 'org-1', name: 'Acme' });
    mockSubCreate.mockResolvedValue({ id: 'sub-1' });
    mockFindUserSub.mockResolvedValue(null);
    mockAddCredits.mockResolvedValue({ creditHolder: { currentCredits: 0 }, creditTransactionId: 'tx-sub-grant' });
  });

  describe.each(bodies)('%s grant', (_type, body) => {
    it.each([
      ['missing', undefined],
      ['under five characters', ' abc '],
      ['over 500 characters', 'x'.repeat(501)],
    ])('answers 400 and grants nothing when the reason is %s', async (_label, reason) => {
      await expect(callWith({ ...body, reason })()).rejects.toMatchObject({ statusCode: 400 });
      expect(mockSubCreate).not.toHaveBeenCalled();
      expect(mockAddCredits).not.toHaveBeenCalled();
      expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
    });

    it('allows a self-grant through the ledger and flags it in the audit entry', async () => {
      await callWith({ ...body, reason: REASON }, 'admin-1')();
      expect(mockAddCredits).toHaveBeenCalled();
      expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'user.subscription.granted',
          details: expect.objectContaining({ selfGrant: true }),
        })
      );
    });

    it('flags a grant to the account an impersonating admin impersonates from', async () => {
      const user = { isAdmin: true, id: 'admin-2', email: 'b@example.com', impersonatedBy: 'admin-1' };
      await callWith({ ...body, reason: REASON }, 'admin-1', user)();
      expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ details: expect.objectContaining({ selfGrant: true }) })
      );
    });

    it('does not flag a grant to another account', async () => {
      await callWith({ ...body, reason: REASON })();
      expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ details: expect.objectContaining({ selfGrant: false }) })
      );
    });
  });
});
