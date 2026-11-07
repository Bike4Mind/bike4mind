import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import type { AdminUsersBulkAction, AdminUsersBulkExecuteRequest } from '@client/app/utils/adminUsersBulk';
import { cohortHashOf, type BulkUser, type ResolveDeps } from './resolve';

const mocks = vi.hoisted(() => ({
  policy: vi.fn(),
  requestApproval: vi.fn(),
  recentCredits: vi.fn(),
  recentUsers: vi.fn(),
}));
const reservations = vi.hoisted(() => {
  const rows = new Map<string, { actorUserId: string; kind: string; amount: number }>();
  let next = 0;
  return {
    rows,
    reserve: vi.fn(async (actorUserId: string, kind: string, amount: number) => {
      const id = String(++next);
      rows.set(id, { actorUserId, kind, amount });
      return id;
    }),
    sumReserved: vi.fn(async (actorUserId: string, kind: string) =>
      [...rows.values()].filter(r => r.actorUserId === actorUserId && r.kind === kind).reduce((t, r) => t + r.amount, 0)
    ),
    release: vi.fn(async (id: string) => void rows.delete(id)),
  };
});
vi.mock('@bike4mind/database', () => ({
  adminAuditLogRepository: { sumCreditsGranted: mocks.recentCredits, countActions: mocks.recentUsers },
  adminGateReservationRepository: reservations,
}));
vi.mock('@server/admin/approvals/service', () => ({
  getApprovalPolicy: mocks.policy,
  requestApproval: mocks.requestApproval,
}));
vi.mock('./adapters', () => ({ usersBulkResolveDeps: {} }));

import { requestUsersBulkApprovalIfNeeded } from './approvalGate';

const ADMIN = 'a'.repeat(24);
const PENDING = { approvalId: 'p'.repeat(24), status: 'pending', expiresAt: new Date() };
const idOf = (n: number) => n.toString(16).padStart(24, '0');

const userRow = (id: string, credits = 100): BulkUser => ({
  id,
  name: null,
  email: null,
  username: null,
  isAdmin: false,
  isBanned: false,
  isModerated: false,
  tags: [],
  currentCredits: credits,
  disputePending: false,
  moderationStatus: null,
});

const depsFor = (users: BulkUser[]): ResolveDeps => ({
  findUsersByIds: vi.fn(async (ids: string[]) => users.filter(user => ids.includes(user.id))),
  openFilterPages: vi.fn(async () => async (afterId: string | null) => (afterId ? [] : users)),
});

const req = { user: { id: ADMIN, isAdmin: true } } as unknown as Request;

const requestFor = (
  users: BulkUser[],
  action: AdminUsersBulkAction,
  overrides: Partial<AdminUsersBulkExecuteRequest> = {}
): AdminUsersBulkExecuteRequest => ({
  target: { kind: 'ids', userIds: users.map(user => user.id) },
  action,
  reason: 'Coordinated abuse from one campaign',
  idempotencyKey: '7b1f3c52-9a3e-4b8e-8f43-2f4a1c9d0e11',
  expectedCount: users.length,
  cohortHash: cohortHashOf(users),
  ...overrides,
});

const cohort = (count: number, credits = 100) => Array.from({ length: count }, (_, i) => userRow(idOf(i + 1), credits));

describe('requestUsersBulkApprovalIfNeeded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reservations.rows.clear();
    mocks.recentCredits.mockResolvedValue(0);
    mocks.recentUsers.mockResolvedValue(0);
    mocks.policy.mockResolvedValue({ enabled: true, bulkUserThreshold: 2, creditThreshold: 1000, expiryHours: 24 });
    mocks.requestApproval.mockResolvedValue(PENDING);
  });

  it('runs at the threshold and asks for approval one user above it', async () => {
    const two = cohort(2);
    expect(
      await requestUsersBulkApprovalIfNeeded(req, requestFor(two, { type: 'suspend' }), depsFor(two))
    ).toMatchObject({ pending: null });

    const three = cohort(3);
    const body = requestFor(three, { type: 'suspend' });
    expect(await requestUsersBulkApprovalIfNeeded(req, body, depsFor(three))).toEqual({ pending: PENDING });
    expect(mocks.requestApproval).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'users.bulk',
        requiredPermission: 'users:moderate',
        requiresFullAdmin: true,
        reason: body.reason,
      }),
      expect.objectContaining({ enabled: true })
    );
  });

  it('counts the users this admin already moved over the expiry window, so a split batch is held', async () => {
    const two = cohort(2);
    mocks.recentUsers.mockResolvedValue(1);
    expect(await requestUsersBulkApprovalIfNeeded(req, requestFor(two, { type: 'contain' }), depsFor(two))).toEqual({
      pending: PENDING,
    });
    const [actor, actions, since] = mocks.recentUsers.mock.calls[0] as [string, string[], Date];
    expect(actor).toBe(ADMIN);
    expect(actions.sort()).toEqual(['user.bulk.contained', 'user.bulk.credits_adjusted', 'user.bulk.suspended']);
    expect(Date.now() - since.getTime()).toBeCloseTo(24 * 60 * 60 * 1000, -4);
  });

  it('leaves everything to the legacy path when approvals are off', async () => {
    mocks.policy.mockResolvedValue({ enabled: false, bulkUserThreshold: 1, creditThreshold: 1, expiryHours: 24 });
    const users = cohort(5);
    expect(
      await requestUsersBulkApprovalIfNeeded(req, requestFor(users, { type: 'contain' }), depsFor(users))
    ).toMatchObject({ pending: null });
    expect(mocks.requestApproval).not.toHaveBeenCalled();
  });

  it.each<AdminUsersBulkAction>([{ type: 'restrict' }, { type: 'revokeApiKeys' }, { type: 'addTag', tag: 'x' }])(
    'never gates $type',
    async action => {
      const users = cohort(5);
      expect(await requestUsersBulkApprovalIfNeeded(req, requestFor(users, action), depsFor(users))).toMatchObject({
        pending: null,
      });
      expect(mocks.policy).not.toHaveBeenCalled();
    }
  );

  it('gates a small credit adjustment on the credits it adds, under credits:adjust', async () => {
    const users = cohort(1);
    const add = (amount: number): AdminUsersBulkAction => ({ type: 'adjustCredits', mode: 'add', amount });
    expect(await requestUsersBulkApprovalIfNeeded(req, requestFor(users, add(1000)), depsFor(users))).toMatchObject({
      pending: null,
    });
    expect(await requestUsersBulkApprovalIfNeeded(req, requestFor(users, add(1001)), depsFor(users))).toEqual({
      pending: PENDING,
    });
    mocks.recentCredits.mockResolvedValueOnce(1);
    expect(await requestUsersBulkApprovalIfNeeded(req, requestFor(users, add(1000)), depsFor(users))).toEqual({
      pending: PENDING,
    });
    expect(mocks.requestApproval).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ requiredPermission: 'credits:adjust', requiresFullAdmin: true }),
      expect.anything()
    );
  });

  it('judges the resolved cohort, so a lowered expectedCount is a 409 and nothing is stored', async () => {
    const users = cohort(3);
    const tampered = requestFor(users, { type: 'suspend' }, { expectedCount: 2 });
    await expect(requestUsersBulkApprovalIfNeeded(req, tampered, depsFor(users))).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(mocks.requestApproval).not.toHaveBeenCalled();
  });

  it('stores a filter target as the sorted resolved ids', async () => {
    const users = cohort(3).reverse();
    const body = requestFor(users, { type: 'suspend' }, { target: { kind: 'filter', filter: {} as never } });
    await requestUsersBulkApprovalIfNeeded(req, body, depsFor(users));
    const stored = mocks.requestApproval.mock.calls[0][1].params as AdminUsersBulkExecuteRequest;
    expect(stored.target).toEqual({ kind: 'ids', userIds: [idOf(1), idOf(2), idOf(3)] });
    expect(stored.idempotencyKey).toBe(body.idempotencyKey);
    expect(stored.cohortHash).toBe(body.cohortHash);
  });

  it('binds a direct set action to the balances used for its credit gate', async () => {
    const users = cohort(1, 1000);
    expect(
      await requestUsersBulkApprovalIfNeeded(
        req,
        requestFor(users, { type: 'adjustCredits', mode: 'set', amount: 1000 }),
        depsFor(users)
      )
    ).toMatchObject({ pending: null, creditBalances: { [users[0].id]: 1000 } });
  });

  it('reserves positive set grants without offsetting deductions that may fail independently', async () => {
    mocks.policy.mockResolvedValue({ enabled: true, bulkUserThreshold: 2, creditThreshold: 100, expiryHours: 24 });
    const users = [userRow(idOf(1), 0), userRow(idOf(2), 200)];
    const action: AdminUsersBulkAction = { type: 'adjustCredits', mode: 'set', amount: 100 };
    expect(await requestUsersBulkApprovalIfNeeded(req, requestFor(users, action), depsFor(users))).toMatchObject({
      pending: null,
    });
    expect([...reservations.rows.values()].filter(row => row.kind === 'credits')).toEqual([
      { actorUserId: ADMIN, kind: 'credits', amount: 100 },
    ]);
  });

  it('requires approval when positive set grants exceed the threshold even with zero net change', async () => {
    mocks.policy.mockResolvedValue({ enabled: true, bulkUserThreshold: 2, creditThreshold: 99, expiryHours: 24 });
    const users = [userRow(idOf(1), 0), userRow(idOf(2), 200)];
    const action: AdminUsersBulkAction = { type: 'adjustCredits', mode: 'set', amount: 100 };
    expect(await requestUsersBulkApprovalIfNeeded(req, requestFor(users, action), depsFor(users))).toEqual({
      pending: PENDING,
    });
    expect(reservations.rows.size).toBe(0);
  });
});
