import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { BadRequestError, NotFoundError } from '@bike4mind/common';

const h = vi.hoisted(() => ({ findUser: vi.fn(), sum: vi.fn(), list: vi.fn(), reserved: vi.fn() }));

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (config?: unknown) => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => handlers[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((handlers.GET = fns[fns.length - 1]), chain),
        _config: config,
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));
vi.mock('@bike4mind/database', () => ({
  adminAuditLogRepository: { sumCreditsGrantedTo: h.sum, listCreditGrantsTo: h.list },
  adminGateReservationRepository: { sumReserved: h.reserved },
  userRepository: { findById: h.findUser },
}));
vi.mock('@server/admin/approvals/service', () => ({ getApprovalPolicy: vi.fn() }));
// Fake id. The real list check (seniorGranters.ts) runs over this list; every other Config value stays real.
const { LISTED } = vi.hoisted(() => ({ LISTED: '650000000000000000000007' }));
vi.mock('@bike4mind/server-utils/utils/config', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/server-utils/utils/config')>();
  return { ...actual, Config: Object.create(actual.Config, { ADMIN_SENIOR_GRANTER_IDS: { value: LISTED } }) };
});

import handler from '../recent-credit-grants';

const USER_ID = '650000000000000000000001';
const NOW = new Date('2026-06-15T12:00:00Z');
const actor = (fields: { name: string; email?: string }) => ({
  kind: 'user',
  scope: 'platform',
  userId: 'admin-2',
  wasAdmin: true,
  ...fields,
});

const run = (userId: string = USER_ID, user: Record<string, unknown> = { id: 'admin-1', isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'GET', query: { userId } });
  (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.resetAllMocks();
  h.findUser.mockImplementation(async (id: string) => (id === USER_ID ? { id: USER_ID } : null));
  h.sum.mockResolvedValue(0);
  h.reserved.mockResolvedValue(0);
  h.list.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/admin/users/[userId]/recent-credit-grants', () => {
  it('is session-only and gated by credits:adjust', () => {
    expect((handler as unknown as { _config?: unknown })._config).toEqual({
      auth: 'jwtOnly',
      adminPermissions: { GET: 'credits:adjust' },
    });
  });

  it('reads the last 24 hours, three grants at most, and keeps the newest-first order', async () => {
    h.sum.mockResolvedValue(9_000);
    h.reserved.mockResolvedValue(1_000);
    h.list.mockResolvedValue([
      { occurredAt: new Date('2026-06-15T11:00:00Z'), actor: actor({ name: 'Grace' }), details: { credits: 4_000 } },
      {
        occurredAt: new Date('2026-06-15T09:00:00Z'),
        actor: actor({ name: ' ', email: 'ops@example.com' }),
        details: { credits: 2_500 },
      },
      { occurredAt: new Date('2026-06-14T13:00:00Z'), actor: actor({ name: '' }), details: { credits: 1_000 } },
    ]);

    const { res, promise } = run();
    await promise;

    const since = new Date('2026-06-14T12:00:00Z');
    expect(h.sum).toHaveBeenCalledWith(USER_ID, since);
    expect(h.list).toHaveBeenCalledWith(USER_ID, since, 3);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({
      receivedCredits: 10_000,
      immediateLimit: 100_000,
      grants: [
        { at: '2026-06-15T11:00:00.000Z', credits: 4_000, grantedBy: 'Grace' },
        { at: '2026-06-15T09:00:00.000Z', credits: 2_500, grantedBy: 'ops@example.com' },
        { at: '2026-06-14T13:00:00.000Z', credits: 1_000, grantedBy: 'Unknown admin' },
      ],
    });
  });

  it('answers an empty window with nothing received and no grants', async () => {
    const { res, promise } = run();
    await promise;
    expect(res._getJSONData()).toEqual({ receivedCredits: 0, immediateLimit: 100_000, grants: [] });
  });

  it.each([
    [
      'a listed approver granting another user',
      { id: LISTED, isAdmin: true, adminPermissions: ['credits:approve_self_grant'] },
      USER_ID,
      500_000,
    ],
    [
      'an unlisted holder of credits:approve_self_grant',
      { id: 'admin-1', isAdmin: true, adminPermissions: ['credits:approve_self_grant'] },
      USER_ID,
      100_000,
    ],
    ['a full admin granting their own account', { id: USER_ID, isAdmin: true }, USER_ID, 100_000],
    [
      'a listed approver granting their own account',
      { id: LISTED, isAdmin: true, adminPermissions: ['credits:approve_self_grant'] },
      LISTED,
      100_000,
    ],
    [
      'a listed credits:self_grant holder granting their own account',
      { id: LISTED, isAdmin: true, adminPermissions: ['credits:self_grant'] },
      LISTED,
      500_000,
    ],
  ])('gives %s its immediate limit', async (_label, user, userId, immediateLimit) => {
    h.findUser.mockResolvedValue({ id: userId });
    const { res, promise } = run(userId, user);
    await promise;
    expect(res._getJSONData()).toMatchObject({ immediateLimit });
  });

  it('rejects a malformed id and answers 404 for a missing user', async () => {
    await expect(run('not-an-id').promise).rejects.toBeInstanceOf(BadRequestError);
    await expect(run('650000000000000000000009').promise).rejects.toBeInstanceOf(NotFoundError);
    expect(h.list).not.toHaveBeenCalled();
  });
});
