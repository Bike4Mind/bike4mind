import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiKeyScope, CreditHolderType, type SpendAccountsResponse, type SpendBreakdown } from '@bike4mind/common';

const m = vi.hoisted(() => ({
  spendBreakdown: vi.fn(),
  userFind: vi.fn(),
  orgFind: vi.fn(),
  getCachedData: vi.fn((_key: string, factory: () => unknown) => factory()),
}));

vi.mock('@server/middlewares/baseApi', async () => ({
  baseApi: (await import('@server/admin/spendExplorer/__tests__/routeTestHarness')).baseApiStub,
}));
vi.mock('@bike4mind/database', () => ({
  usageEventRepository: { spendBreakdown: (...a: unknown[]) => m.spendBreakdown(...a) },
  cacheRepository: {},
  User: { find: (...a: unknown[]) => m.userFind(...a) },
  Organization: { find: (...a: unknown[]) => m.orgFind(...a) },
  AdminAuditLogModel: { find: vi.fn() },
}));
vi.mock('@bike4mind/services', () => ({
  cacheService: { getCachedData: (...a: unknown[]) => m.getCachedData(...(a as [string, () => unknown])) },
}));

import handler from '../accounts';
import { findReturning, NON_ADMIN_USER, runGet } from '@server/admin/spendExplorer/__tests__/routeTestHarness';

const USER_ID = 'a'.repeat(24);
const ORG_ID = 'b'.repeat(24);
const NEW_USER_ID = 'c'.repeat(24);
const MEMBER_ID = 'd'.repeat(24);

const get = (query: Record<string, string>) => runGet<SpendAccountsResponse>(handler, query);

const breakdown = (topActors: SpendBreakdown['topActors'], total = 100): SpendBreakdown => ({
  totalCostUsd: total,
  byProvider: [
    { provider: 'anthropic', costUsd: 60 },
    { provider: 'gemini', costUsd: 25 },
    { provider: 'xai', costUsd: 15 },
  ],
  bySegment: [{ segment: 'customer', costUsd: total }],
  topActors,
});

beforeEach(() => {
  vi.clearAllMocks();
  // Reset drops queued *Once implementations a test that never queried left behind.
  m.userFind.mockReset();
  m.orgFind.mockReset();
  m.spendBreakdown.mockReset();
  // First call: user lookup for segments (none tagged); later calls: name resolution.
  m.userFind.mockImplementationOnce(findReturning([])).mockImplementation(
    findReturning([
      { _id: USER_ID, name: 'User A', createdAt: new Date('2026-11-01T00:00:00Z') },
      { _id: MEMBER_ID, name: 'Member B', createdAt: new Date('2025-06-01T00:00:00Z') },
    ])
  );
  m.orgFind
    .mockImplementationOnce(findReturning([{ _id: ORG_ID, accountSegment: 'partner' }]))
    .mockImplementation(
      findReturning([{ _id: ORG_ID, name: 'Org Alpha', createdAt: new Date('2025-01-01T00:00:00Z') }])
    );
});

describe('GET /api/admin/spend-explorer/accounts', () => {
  it('is admin-gated, first-party JWT only, with the admin API-key scope', () => {
    const config = (handler as unknown as { _config: { requiredScopes: string[]; auth: string } })._config;
    expect(config.requiredScopes).toEqual([ApiKeyScope.ADMIN]);
    expect(config.auth).toBe('jwtOnly');
  });

  it('lets a support:read delegate in and keeps a settings:manage-only delegate out', async () => {
    m.spendBreakdown.mockResolvedValue(breakdown([]));
    const query = { from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z' };
    const allowed = await runGet(handler, query, { isAdmin: false, id: 'd-1', adminPermissions: ['support:read'] });
    expect(allowed.thrown).toBeUndefined();

    const denied = await runGet(handler, query, { isAdmin: false, id: 'd-2', adminPermissions: ['settings:manage'] });
    expect(denied.thrown).toMatchObject({ statusCode: 403 });
  });

  it('keys the cache by range, limit and comparison window, and passes recache through', async () => {
    m.spendBreakdown.mockResolvedValue(breakdown([]));
    const base = { from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z' };
    await get(base);
    await get({ ...base, limit: '5' });
    await get({ ...base, compareFrom: '2026-11-09T00:00:00Z', compareTo: '2026-11-10T00:00:00Z' });
    await get({ ...base, recache: 'true' });
    const calls = m.getCachedData.mock.calls;
    expect(new Set(calls.slice(0, 3).map(call => call[0])).size).toBe(3);
    expect(calls[3][0]).toBe(calls[0][0]);
    expect(calls[0][2]).toMatchObject({ recache: false });
    expect(calls[3][2]).toMatchObject({ recache: true });
  });

  const personal = (userId: string, costUsd: number) => [
    { ownerId: userId, ownerType: CreditHolderType.User, costUsd },
  ];

  it('ranks acting users, shows who paid, resolves names, segments and ages, and flags new top-10 users', async () => {
    m.spendBreakdown
      .mockResolvedValueOnce(
        breakdown([
          // A team member whose calls mostly bill to the (partner-tagged) org.
          {
            userId: MEMBER_ID,
            costUsd: 50,
            requests: 5,
            payers: [
              { ownerId: ORG_ID, ownerType: CreditHolderType.Organization, costUsd: 45 },
              { ownerId: MEMBER_ID, ownerType: CreditHolderType.User, costUsd: 5 },
            ],
          },
          { userId: USER_ID, costUsd: 30, requests: 3, payers: personal(USER_ID, 30) },
          { userId: NEW_USER_ID, costUsd: 20, requests: 2, payers: personal(NEW_USER_ID, 20) },
        ])
      )
      .mockResolvedValueOnce(
        breakdown([
          { userId: MEMBER_ID, costUsd: 5, requests: 1, payers: personal(MEMBER_ID, 5) },
          { userId: USER_ID, costUsd: 5, requests: 1, payers: personal(USER_ID, 5) },
        ])
      );

    const { body } = await get({
      from: '2026-11-10T00:00:00Z',
      to: '2026-11-11T00:00:00Z',
      compareFrom: '2026-11-03T00:00:00Z',
      compareTo: '2026-11-10T00:00:00Z',
    });

    expect(m.spendBreakdown).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ from: new Date('2026-11-03T00:00:00Z'), limit: 10 })
    );
    expect(body?.byProvider).toEqual([
      { provider: 'anthropic', costUsd: 60 },
      { provider: 'other', costUsd: 40 },
    ]);
    expect(body?.accounts).toEqual([
      {
        accountId: MEMBER_ID,
        name: 'Member B',
        // Untagged user inherits the tag of the org that paid most of their spend.
        segment: 'partner',
        costUsd: 50,
        share: 0.5,
        requests: 5,
        createdAt: '2025-06-01T00:00:00.000Z',
        payers: [
          { ownerId: ORG_ID, ownerType: CreditHolderType.Organization, name: 'Org Alpha', costUsd: 45 },
          { ownerId: MEMBER_ID, ownerType: CreditHolderType.User, name: 'Member B', costUsd: 5 },
        ],
        newInTop10: false,
      },
      expect.objectContaining({ accountId: USER_ID, name: 'User A', segment: 'customer', newInTop10: false }),
      // Unresolved user keeps their raw id and has no age.
      expect.objectContaining({ accountId: NEW_USER_ID, name: NEW_USER_ID, createdAt: null, newInTop10: true }),
    ]);
  });

  it('refuses a caller without admin access', async () => {
    const { thrown } = await runGet(
      handler,
      { from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z' },
      NON_ADMIN_USER
    );
    expect(thrown).toMatchObject({ statusCode: 403 });
    expect(m.spendBreakdown).not.toHaveBeenCalled();
  });

  it('never flags new accounts without a comparison window', async () => {
    m.spendBreakdown.mockResolvedValueOnce(
      breakdown([{ userId: USER_ID, costUsd: 30, requests: 3, payers: personal(USER_ID, 30) }])
    );
    const { body } = await get({ from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z' });
    expect(m.spendBreakdown).toHaveBeenCalledTimes(1);
    expect(body?.accounts[0].newInTop10).toBe(false);
  });

  it.each([
    [{ from: '2026-11-10T00:00:00Z' }],
    [
      {
        from: '2026-11-10T00:00:00Z',
        to: '2026-11-11T00:00:00Z',
        compareFrom: '2000-01-01T00:00:00Z',
        compareTo: '2026-11-10T00:00:00Z',
      },
    ],
    [{ from: '2026-11-11T00:00:00Z', to: '2026-11-10T00:00:00Z' }],
    [{ from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z', limit: '500' }],
    [{ from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z', compareFrom: '2026-11-03T00:00:00Z' }],
    [{ from: '2024-01-01T00:00:00Z', to: '2026-11-11T00:00:00Z' }],
  ])('rejects an invalid query %j', async query => {
    const { thrown } = await get(query);
    expect(thrown).toMatchObject({ statusCode: 400 });
    expect(m.spendBreakdown).not.toHaveBeenCalled();
  });
});
