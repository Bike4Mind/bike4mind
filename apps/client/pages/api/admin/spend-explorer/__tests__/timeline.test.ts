import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiKeyScope, type SpendTimelineResponse } from '@bike4mind/common';

const m = vi.hoisted(() => ({
  spendTimeline: vi.fn(),
  userFind: vi.fn(),
  orgFind: vi.fn(),
  auditFind: vi.fn(),
  getCachedData: vi.fn((_key: string, factory: () => unknown) => factory()),
}));

vi.mock('@server/middlewares/baseApi', async () => ({
  baseApi: (await import('@server/admin/spendExplorer/__tests__/routeTestHarness')).baseApiStub,
}));
vi.mock('@bike4mind/database', () => ({
  usageEventRepository: { spendTimeline: (...a: unknown[]) => m.spendTimeline(...a) },
  cacheRepository: {},
  User: { find: (...a: unknown[]) => m.userFind(...a) },
  Organization: { find: (...a: unknown[]) => m.orgFind(...a) },
  AdminAuditLogModel: { find: (...a: unknown[]) => m.auditFind(...a) },
}));
vi.mock('@bike4mind/services', () => ({
  cacheService: { getCachedData: (...a: unknown[]) => m.getCachedData(...(a as [string, () => unknown])) },
}));

import { SUSPEND_ACTIONS } from '@bike4mind/server-utils/security/accountStatusAuditActions';
import handler from '../timeline';
import { findReturning, NON_ADMIN_USER, runGet } from '@server/admin/spendExplorer/__tests__/routeTestHarness';

const get = (query: Record<string, string>) => runGet<SpendTimelineResponse>(handler, query);

beforeEach(() => {
  vi.clearAllMocks();
  m.spendTimeline.mockResolvedValue([]);
  m.auditFind.mockImplementation(findReturning([{ occurredAt: new Date('2026-11-10T03:00:00Z') }]));
  m.userFind.mockImplementation(findReturning([{ _id: 'u-int', isInternal: true }]));
  m.orgFind.mockImplementation(findReturning([{ _id: 'o-partner', accountSegment: 'partner' }]));
});

describe('GET /api/admin/spend-explorer/timeline', () => {
  it('is admin-gated, first-party JWT only, with the admin API-key scope', () => {
    const config = (handler as unknown as { _config: { requiredScopes: string[]; auth: string } })._config;
    expect(config.requiredScopes).toEqual([ApiKeyScope.ADMIN]);
    expect(config.auth).toBe('jwtOnly');
  });

  it('defaults to daily buckets, snaps the range to whole UTC days and reaches back for the baseline', async () => {
    m.spendTimeline.mockResolvedValue([{ bucket: '2026-11-10', key: 'anthropic', costUsd: 4, requests: 2 }]);
    const { body } = await get({ from: '2026-11-08T10:00:00Z', to: '2026-11-15T10:00:00Z' });

    expect(m.spendTimeline).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: 'day',
        splitBy: 'provider',
        // 8 snapped days back from 2026-11-08 for the previous period.
        from: new Date('2026-10-31T00:00:00Z'),
        to: new Date('2026-11-16T00:00:00Z'),
        segmentIds: { internal: [], partner: [] },
      })
    );
    expect(body?.buckets).toHaveLength(8);
    expect(body?.buckets[2]).toMatchObject({
      start: '2026-11-10T00:00:00.000Z',
      totalUsd: 4,
      series: { anthropic: 4 },
    });
    expect(body?.markers).toEqual([{ at: '2026-11-10T03:00:00.000Z', kind: 'suspension', label: 'Account suspended' }]);
    // The segment lookup is skipped for non-segment splits.
    expect(m.userFind).not.toHaveBeenCalled();
  });

  it('switches to hourly buckets for ranges of three days or less', async () => {
    const { body } = await get({ from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z' });
    expect(body?.bucket).toBe('hour');
    expect(body?.buckets).toHaveLength(24);
  });

  it('loads segment ids for the segment split and narrows to the calls one user ran', async () => {
    await get({ from: '2026-11-01T00:00:00Z', to: '2026-11-10T00:00:00Z', splitBy: 'segment', userId: 'u-1' });
    expect(m.spendTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ segmentIds: { internal: ['u-int'], partner: ['o-partner'] }, actorUserId: 'u-1' })
    );
    expect(m.auditFind).toHaveBeenCalledWith(
      expect.objectContaining({ 'target.id': 'u-1', action: { $in: SUSPEND_ACTIONS } })
    );
  });

  it('refuses a caller without admin access', async () => {
    const { thrown } = await runGet(
      handler,
      { from: '2026-11-01T00:00:00Z', to: '2026-11-10T00:00:00Z' },
      NON_ADMIN_USER
    );
    expect(thrown).toMatchObject({ statusCode: 403 });
    expect(m.spendTimeline).not.toHaveBeenCalled();
  });

  it('lets a support:read delegate in and keeps a settings:manage-only delegate out', async () => {
    const query = { from: '2026-11-01T00:00:00Z', to: '2026-11-10T00:00:00Z' };
    const allowed = await runGet(handler, query, { isAdmin: false, id: 'd-1', adminPermissions: ['support:read'] });
    expect(allowed.thrown).toBeUndefined();

    const denied = await runGet(handler, query, { isAdmin: false, id: 'd-2', adminPermissions: ['settings:manage'] });
    expect(denied.thrown).toMatchObject({ statusCode: 403 });
  });

  it('accepts an unaligned 400-day range and rejects one past the cap', async () => {
    const ok = await get({ from: '2025-10-01T10:00:00Z', to: '2026-11-05T10:00:00Z' });
    expect(ok.thrown).toBeUndefined();
    expect(ok.body?.buckets).toHaveLength(401);

    const tooWide = await get({ from: '2025-10-01T10:00:00Z', to: '2026-11-06T10:00:00Z' });
    expect(tooWide.thrown).toMatchObject({ statusCode: 400 });
  });

  it('keys the cache by user and split, and defaults recache to false', async () => {
    const base = { from: '2026-11-01T00:00:00Z', to: '2026-11-10T00:00:00Z' };
    await get(base);
    await get({ ...base, userId: 'u-1' });
    await get({ ...base, splitBy: 'model' });
    const keys = m.getCachedData.mock.calls.map(call => call[0]);
    expect(new Set(keys).size).toBe(3);
    expect(m.getCachedData).toHaveBeenCalledWith(
      keys[0],
      expect.any(Function),
      expect.objectContaining({ recache: false })
    );
  });

  it.each([
    [{ from: 'nope', to: '2026-11-10T00:00:00Z' }],
    [{ from: '2026-11-10T00:00:00Z', to: '2026-11-01T00:00:00Z' }],
    [{ from: '2026-11-01T00:00:00Z', to: '2026-11-10T00:00:00Z', splitBy: 'colour' }],
    [{ from: '2026-11-01T00:00:00Z', to: '2026-11-10T00:00:00Z', bucket: 'hour' }],
    [{ from: '2026-11-01T00:00:00Z', to: '2026-11-10T00:00:00Z', userId: '' }],
  ])('rejects an invalid query %j', async query => {
    const { thrown } = await get(query);
    expect(thrown).toMatchObject({ statusCode: 400 });
    expect(m.spendTimeline).not.toHaveBeenCalled();
  });

  it('passes recache through to the cache', async () => {
    await get({ from: '2026-11-01T00:00:00Z', to: '2026-11-10T00:00:00Z', recache: 'true' });
    expect(m.getCachedData).toHaveBeenCalledWith(
      expect.stringMatching(/^admin-spend-explorer:timeline:/),
      expect.any(Function),
      expect.objectContaining({ recache: true })
    );
  });
});
