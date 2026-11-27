import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: () => {
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
const mockOrgFindById = vi.fn();
vi.mock('@bike4mind/database', () => ({
  creditLotRepository: {},
  creditTransactionRepository: {},
  organizationRepository: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
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
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({
  subscriptionRepository: {
    create: (...a: unknown[]) => mockSubCreate(...a),
    findByPriceIdAndOwner: vi.fn().mockResolvedValue(null),
    findUserSubscriptionByPriceId: (...a: unknown[]) => mockFindUserSub(...a),
  },
}));

vi.mock('@bike4mind/server-utils/services/teamPlanSettings', () => ({
  getTeamPlanSettings: vi.fn(async () => ({ minSeats: 3, maxSeats: 8, creditsPerSeat: 1000 })),
}));
vi.mock('@bike4mind/server-utils/websocket/utils', () => ({ sendToClient: vi.fn() }));
// parseAdminActionReason and isSameUserId stay real; the denied helper records, then throws a 403.
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>();
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

import { SUBSCRIPTION_PLANS } from '@bike4mind/server-utils/lib/userSubscriptions/constants';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { sendToClient } from '@bike4mind/server-utils/websocket/utils';
const approvalMocks = vi.hoisted(() => ({
  policy: vi.fn(async (_credits: number): Promise<unknown> => null),
  request: vi.fn(),
  gateOptions: vi.fn(),
}));
const DISABLED_POLICY = { enabled: false, bulkUserThreshold: 25, creditThreshold: 10, expiryHours: 24 };
vi.mock('@server/admin/creditGrants/gate', () => ({
  // Like the real gate, a held self-grant gets the policy even with approvals disabled.
  creditGrantNeedsApproval: async (credits: number, _actorId: string, opts?: { heldSelfGrant?: boolean }) => {
    approvalMocks.gateOptions(opts);
    const policy = await approvalMocks.policy(credits);
    if (opts?.heldSelfGrant) return { policy: policy ?? DISABLED_POLICY };
    return policy ? { policy } : { policy: null, release: async () => undefined };
  },
}));
vi.mock('@server/admin/approvals/service', () => ({
  requestApproval: (...a: unknown[]) => approvalMocks.request(...a),
}));
const POLICY = { enabled: true, bulkUserThreshold: 25, creditThreshold: 10, expiryHours: 24 };
const PENDING = { approvalId: 'approval-1', status: 'pending' };

import handler from '../grant-subscription';
import type { Request } from 'express';
import type { AdminApproval } from '@bike4mind/common';
import { grantSubscription } from '@server/admin/creditGrants/grantSubscription';

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
    expect(mockSubCreate).toHaveBeenCalledWith(expect.objectContaining({ grantedReason: REASON }));
    expect(mockAddCredits).toHaveBeenCalledWith(expect.objectContaining({ credits: 5 * 1000 }), expect.anything());
    expect(res._getJSONData()).toMatchObject({ seats: 5, credits: 5 * 1000 });
  });

  it('still answers success for a team grant when the post-commit cache push fails', async () => {
    vi.mocked(sendToClient).mockRejectedValueOnce(new Error('socket down'));
    const { res, run } = call(5);
    await run();
    expect(sendToClient).toHaveBeenCalled();
    expect(res._getStatusCode()).toBe(200);
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
        details: expect.objectContaining({
          subscriptionType: 'team',
          seats: 5,
          credits: 5 * 1000,
          subscriptionId: expect.stringMatching(/^admin_grant_/),
        }),
        related: { creditTransactionId: 'tx-sub-grant' },
      })
    );
  });

  it('names the new row in the audit details and returns its record id', async () => {
    const { res, run } = call(5);
    await run();
    const [, input] = vi.mocked(recordAdminActionFromRequest).mock.calls[0];
    const grantedRowSubscriptionId = mockSubCreate.mock.calls[0][0].subscriptionId;
    expect(input.details).toMatchObject({ subscriptionId: grantedRowSubscriptionId });
    expect(res._getJSONData()).toMatchObject({ subscriptionRecordId: 'sub-1' });
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
      expect.objectContaining({
        ownerId: 'user-1',
        priceId: plan.priceId,
        grantedBy: 'admin-1',
        grantedReason: REASON,
        quantity: 1,
      })
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
        details: expect.objectContaining({ subscriptionId: expect.stringMatching(/^admin_grant_/) }),
        related: { creditTransactionId: 'tx-sub-grant' },
      })
    );
    expect(res._getJSONData()).toMatchObject({ subscriptionRecordId: 'sub-1' });
  });

  it('still answers success for an individual grant when the post-commit cache push fails', async () => {
    vi.mocked(sendToClient).mockRejectedValueOnce(new Error('socket down'));
    const { res, run } = callIndividual(plan.priceId);
    await run();
    expect(sendToClient).toHaveBeenCalled();
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ success: true, credits: plan.credits * 2 });
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
      const user = { isAdmin: true, id: 'admin-1', email: 'a@example.com', adminPermissions: ['credits:self_grant'] };
      await callWith({ ...body, reason: REASON }, 'admin-1', user)();
      expect(mockAddCredits).toHaveBeenCalled();
      expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'user.subscription.granted',
          details: expect.objectContaining({ selfGrant: true }),
        })
      );
    });

    it('holds a grant to the account an impersonating admin impersonates from, even with credits:self_grant', async () => {
      approvalMocks.request.mockResolvedValue(PENDING);
      const user = {
        isAdmin: true,
        id: 'admin-2',
        email: 'b@example.com',
        adminPermissions: ['credits:self_grant'],
        impersonatedBy: 'admin-1',
      };
      await callWith({ ...body, reason: REASON }, 'admin-1', user)();
      expect(mockAddCredits).not.toHaveBeenCalled();
      expect(approvalMocks.request).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ requiredPermission: 'credits:approve_self_grant' }),
        expect.anything()
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

describe('POST /api/admin/users/[userId]/grant-subscription - approval gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserFindById.mockResolvedValue({ id: 'user-1', email: 'u@example.com' });
    mockOrgCreate.mockResolvedValue({ id: 'org-1', name: 'Acme' });
    mockSubCreate.mockResolvedValue({ id: 'sub-1' });
    mockAddCredits.mockResolvedValue({ creditHolder: { currentCredits: 0 }, creditTransactionId: 'tx-sub-grant' });
    approvalMocks.request.mockResolvedValue(PENDING);
  });

  it('judges the team grant on seats x per-seat credits and stores that figure', async () => {
    approvalMocks.policy.mockResolvedValueOnce(POLICY);
    const { res, run } = call(5);
    await run();
    expect(approvalMocks.policy).toHaveBeenCalledWith(5 * 1000);
    expect(res._getStatusCode()).toBe(202);
    expect(approvalMocks.request).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.subscription.grant',
        requiredPermission: 'credits:adjust',
        requiresFullAdmin: false,
        params: expect.objectContaining({ userId: 'user-1', seats: 5, creditsAtRequest: 5000 }),
      }),
      POLICY
    );
    expect(mockSubCreate).not.toHaveBeenCalled();
    expect(mockAddCredits).not.toHaveBeenCalled();
  });

  it('holds a grant to the admin own account for credits:approve_self_grant', async () => {
    approvalMocks.policy.mockResolvedValueOnce(POLICY);
    mockUserFindById.mockResolvedValue({ id: 'admin-1', email: 'a@example.com' });
    const { req, res } = createMocks({
      method: 'POST',
      query: { userId: 'admin-1' },
      body: { subscriptionType: 'team', organizationName: 'Acme', seats: 5, reason: REASON },
    });
    (req as unknown as { user: unknown }).user = { isAdmin: true, id: 'admin-1' };
    (req as unknown as { logger: unknown }).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res);
    expect(res._getStatusCode()).toBe(202);
    expect(approvalMocks.request).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.subscription.grant',
        requiredPermission: 'credits:approve_self_grant',
        requiresFullAdmin: false,
      }),
      POLICY
    );
  });

  it.each([
    ['direct', undefined],
    ['impersonated', { impersonatedBy: 'admin-2', adminPermissions: ['credits:self_grant'] }],
  ])('holds a %s self-grant with approvals disabled and answers 202', async (_label, extra) => {
    mockUserFindById.mockResolvedValue({ id: 'admin-1', email: 'a@example.com' });
    const { req, res } = createMocks({
      method: 'POST',
      query: { userId: 'admin-1' },
      body: { subscriptionType: 'team', organizationName: 'Acme', seats: 5, reason: REASON },
    });
    (req as unknown as { user: unknown }).user = { isAdmin: true, id: 'admin-1', ...extra };
    (req as unknown as { logger: unknown }).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res);
    expect(approvalMocks.gateOptions).toHaveBeenCalledWith({ heldSelfGrant: true });
    expect(res._getStatusCode()).toBe(202);
    expect(approvalMocks.request).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requiredPermission: 'credits:approve_self_grant', requiresFullAdmin: false }),
      DISABLED_POLICY
    );
    expect(mockSubCreate).not.toHaveBeenCalled();
  });

  it('refuses with 409 at execute when the per-seat credits changed since the request', async () => {
    const approverReq = { user: { id: 'admin-2', isAdmin: true }, logger: { info: vi.fn() } } as unknown as Request;
    const params = {
      subscriptionType: 'team' as const,
      organizationName: 'Acme',
      seats: 5,
      durationMonths: 1,
      userId: 'user-1',
      reason: REASON,
      creditsAtRequest: 4000,
    };
    await expect(grantSubscription(approverReq, params)).rejects.toMatchObject({ statusCode: 409 });
    expect(mockAddCredits).not.toHaveBeenCalled();
    await grantSubscription(approverReq, { ...params, creditsAtRequest: 5000 });
    expect(mockAddCredits).toHaveBeenCalledWith(expect.objectContaining({ credits: 5000 }), expect.anything());
  });
});

describe('team grant crediting an organization the admin belongs to', () => {
  const ORG = {
    id: 'org-1',
    name: 'Acme',
    userId: 'owner-1',
    seats: 10,
    users: [{ userId: 'admin-1' }, { userId: 'user-1' }],
  };
  const existingOrgBody = { subscriptionType: 'team', organizationId: 'org-1', seats: 5, reason: REASON };

  function callAs(body: Record<string, unknown>, user: Record<string, unknown> = { isAdmin: true, id: 'admin-1' }) {
    const { req, res } = createMocks({ method: 'POST', query: { userId: 'user-1' }, body });
    (req as unknown as { user: unknown }).user = user;
    (req as unknown as { logger: unknown }).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return { res, run: () => (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res) };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockUserFindById.mockResolvedValue({ id: 'user-1', email: 'u@example.com' });
    mockOrgFindById.mockResolvedValue(ORG);
    mockOrgCreate.mockResolvedValue({ id: 'org-2', name: 'Acme', userId: 'admin-1', seats: 5 });
    mockSubCreate.mockResolvedValue({ id: 'sub-1' });
    mockAddCredits.mockResolvedValue({ creditHolder: { currentCredits: 0 }, creditTransactionId: 'tx-sub-grant' });
    approvalMocks.request.mockResolvedValue(PENDING);
  });

  it.each([
    ['an existing organization the admin belongs to, for another member', existingOrgBody],
    [
      'a new organization billed to the admin',
      { ...existingOrgBody, organizationId: undefined, organizationName: 'Acme', billingOwnerId: 'admin-1' },
    ],
  ])('holds a grant to %s for credits:approve_self_grant', async (_label, body) => {
    const { res, run } = callAs(body);
    await run();
    expect(approvalMocks.gateOptions).toHaveBeenCalledWith({ heldSelfGrant: true });
    expect(res._getStatusCode()).toBe(202);
    expect(approvalMocks.request).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requiredPermission: 'credits:approve_self_grant', requiresFullAdmin: false }),
      DISABLED_POLICY
    );
    expect(mockAddCredits).not.toHaveBeenCalled();
    expect(mockSubCreate).not.toHaveBeenCalled();
  });

  it('runs the grant for an admin holding credits:self_grant and flags it in the audit entry', async () => {
    const { res, run } = callAs(existingOrgBody, {
      isAdmin: true,
      id: 'admin-1',
      adminPermissions: ['credits:self_grant'],
    });
    await run();
    expect(res._getStatusCode()).toBe(200);
    expect(mockAddCredits).toHaveBeenCalled();
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ details: expect.objectContaining({ selfGrant: true }) })
    );
  });

  it('runs a grant to an organization the admin is not part of without holding it', async () => {
    mockOrgFindById.mockResolvedValue({ ...ORG, users: [{ userId: 'user-1' }] });
    const { res, run } = callAs(existingOrgBody);
    await run();
    expect(approvalMocks.gateOptions).toHaveBeenCalledWith({ heldSelfGrant: false });
    expect(res._getStatusCode()).toBe(200);
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ details: expect.objectContaining({ selfGrant: false }) })
    );
  });

  describe('approval executor', () => {
    const params = {
      subscriptionType: 'team' as const,
      organizationId: 'org-1',
      seats: 5,
      durationMonths: 1,
      userId: 'user-1',
      reason: REASON,
    };
    const approverReq = (user: Record<string, unknown>) => ({ user, logger: { info: vi.fn() } }) as unknown as Request;
    const approval = {
      id: 'approval-1',
      requiredPermission: 'credits:approve_self_grant',
      requestedBy: { id: 'admin-1', name: 'Ada', selfIds: ['admin-1'] },
    } as unknown as AdminApproval;

    it('flags the audit entry as a self-grant when the requester belongs to the organization', async () => {
      await grantSubscription(approverReq({ id: 'admin-2', isAdmin: true }), params, approval);
      expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ details: expect.objectContaining({ selfGrant: true }) })
      );
    });

    it('lets a delegate approver run it without the target check on an admin member', async () => {
      mockUserFindById.mockResolvedValue({ id: 'user-1', isAdmin: true });
      const approver = { id: 'admin-2', isAdmin: false, adminPermissions: ['credits:approve_self_grant'] };
      await expect(grantSubscription(approverReq(approver), params)).rejects.toThrow();
      await grantSubscription(approverReq(approver), params, approval);
      expect(mockAddCredits).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'org-1' }), expect.anything());
    });

    it('refuses an approver who belongs to the organization and credits nothing', async () => {
      mockOrgFindById.mockResolvedValue({ ...ORG, users: [...ORG.users, { userId: 'admin-2' }] });
      await expect(grantSubscription(approverReq({ id: 'admin-2', isAdmin: true }), params, approval)).rejects.toThrow(
        'You cannot approve credits for an organization you belong to'
      );
      expect(mockAddCredits).not.toHaveBeenCalled();
      expect(mockSubCreate).not.toHaveBeenCalled();
    });

    it('refuses an approver a new organization would be billed to', async () => {
      const newOrgParams = {
        ...params,
        userId: 'admin-1',
        organizationId: undefined,
        organizationName: 'Acme',
        billingOwnerId: 'admin-2',
      };
      await expect(
        grantSubscription(approverReq({ id: 'admin-2', isAdmin: true }), newOrgParams, approval)
      ).rejects.toThrow('You cannot approve credits for an organization you belong to');
      expect(mockOrgCreate).not.toHaveBeenCalled();
    });
  });
});
