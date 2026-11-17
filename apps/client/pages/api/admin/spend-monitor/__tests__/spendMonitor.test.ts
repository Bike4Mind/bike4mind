import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import {
  ForbiddenError,
  meetsAdminPermissionRequirement,
  missingAdminPermissionMessage,
  type AdminPermissionRequirement,
} from '@bike4mind/common';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  permissions: {} as Record<string, unknown>,
  findActive: vi.fn(),
  latestBucketStart: vi.fn(),
  sumWindow: vi.fn(),
  getSettingsMap: vi.fn(),
  userFindByIds: vi.fn(),
  orgFind: vi.fn(),
  keyFind: vi.fn(),
  freezeFindActive: vi.fn(),
}));

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: { adminPermissions: Partial<Record<string, AdminPermissionRequirement>> }) => {
    h.permissions = options.adminPermissions;
    const handlers: Record<string, Handler> = {};
    const chain = {
      use: () => chain,
      get: (fn: Handler) => {
        handlers.GET = async (req, res) => {
          const requirement = options.adminPermissions.GET;
          const { user } = req as { user?: Parameters<typeof meetsAdminPermissionRequirement>[0] };
          if (requirement && !meetsAdminPermissionRequirement(user, requirement)) {
            throw new ForbiddenError(missingAdminPermissionMessage(requirement));
          }
          return fn(req, res);
        };
        return chain;
      },
      handle: (req: { method: string }, res: unknown) => handlers[req.method](req, res),
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: Handler) => fn }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  spendAlertRepository: { findActive: h.findActive },
  spendRollupRepository: { latestBucketStart: h.latestBucketStart, sumWindow: h.sumWindow },
  userRepository: { findByIds: h.userFindByIds },
  organizationRepository: { find: h.orgFind },
  userApiKeyRepository: { find: h.keyFind },
  spendFreezeRepository: { findActive: h.freezeFindActive },
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: h.getSettingsMap,
}));

import route from '../index';

const USER_ID = 'a'.repeat(24);
const ORG_ID = 'b'.repeat(24);

const run = async (user: unknown = { id: 'admin-1', isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'GET' });
  (req as unknown as Record<string, unknown>).user = user;
  await (route as unknown as { handle: Handler }).handle(req, res);
  return res;
};

const incident = (over: Record<string, unknown>) => ({
  id: 'i',
  rule: 'account_spike',
  scopeType: 'User',
  scopeId: USER_ID,
  status: 'open',
  severity: 'warning',
  openedAt: new Date('2026-11-17T10:00:00.000Z'),
  peakValue: 100,
  lastValue: 80,
  context: {},
  ...over,
});

// A settings map where nothing is overridden: every read falls back to the caller's default.
const emptySettings: Record<string, string> = {};

describe('GET /api/admin/spend-monitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findActive.mockResolvedValue([]);
    h.latestBucketStart.mockResolvedValue(new Date('2026-11-17T12:00:00.000Z'));
    h.sumWindow.mockResolvedValue(new Map());
    h.getSettingsMap.mockResolvedValue(emptySettings);
    h.userFindByIds.mockResolvedValue([]);
    h.orgFind.mockResolvedValue([]);
    h.keyFind.mockResolvedValue([]);
    h.freezeFindActive.mockResolvedValue(null);
  });

  it('declares support:read for GET', () => {
    expect(h.permissions).toEqual({ GET: 'support:read' });
  });

  it('refuses a delegate without support:read', async () => {
    await expect(run({ id: 'd', isAdmin: false, adminPermissions: ['credits:adjust'] })).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });

  it('returns incidents with critical first, then newest first', async () => {
    h.findActive.mockResolvedValue([
      incident({ id: 'old-warning', openedAt: new Date('2026-11-17T08:00:00.000Z') }),
      incident({ id: 'new-warning', openedAt: new Date('2026-11-17T11:00:00.000Z') }),
      incident({ id: 'old-critical', severity: 'critical', openedAt: new Date('2026-11-17T07:00:00.000Z') }),
    ]);

    const body = (await run())._getJSONData();

    expect(body.incidents.map((row: { id: string }) => row.id)).toEqual(['old-critical', 'new-warning', 'old-warning']);
    expect(body.incidents[0].openedAt).toBe('2026-11-17T07:00:00.000Z');
  });

  it('labels user, organization and API key incidents and leaves other scopes unlabelled', async () => {
    h.findActive.mockResolvedValue([
      incident({ id: 'u', scopeType: 'User', scopeId: USER_ID }),
      incident({ id: 'o', scopeType: 'Organization', scopeId: ORG_ID }),
      incident({ id: 'p', scopeType: 'platform', scopeId: 'all', rule: 'platform_spike' }),
    ]);
    h.userFindByIds.mockResolvedValue([{ id: USER_ID, email: 'u@example.com', username: 'u' }]);
    h.orgFind.mockResolvedValue([{ id: ORG_ID, name: 'Acme' }]);

    const body = (await run())._getJSONData();
    const labels = Object.fromEntries(
      body.incidents.map((row: { id: string; label: string | null }) => [row.id, row.label])
    );

    expect(labels).toEqual({ u: 'u@example.com', o: 'Acme', p: null });
    expect(h.keyFind).not.toHaveBeenCalled();
  });

  it('reports whether each payer is frozen now, looking each scope up once', async () => {
    h.findActive.mockResolvedValue([
      incident({ id: 'u1', scopeType: 'User', scopeId: USER_ID }),
      incident({ id: 'u2', scopeType: 'User', scopeId: USER_ID, rule: 'account_ceiling' }),
      incident({ id: 'o', scopeType: 'Organization', scopeId: ORG_ID }),
      incident({ id: 'p', scopeType: 'platform', scopeId: 'all', rule: 'platform_spike' }),
    ]);
    h.freezeFindActive.mockImplementation(async (scope: { scopeType: string }) =>
      scope.scopeType === 'User' ? { id: 'freeze' } : null
    );

    const body = (await run())._getJSONData();
    const frozen = Object.fromEntries(
      body.incidents.map((row: { id: string; frozen: boolean }) => [row.id, row.frozen])
    );

    expect(frozen).toEqual({ u1: true, u2: true, o: false, p: false });
    expect(h.freezeFindActive).toHaveBeenCalledTimes(2);
    expect(h.freezeFindActive).toHaveBeenCalledWith({ scopeType: 'User', scopeId: USER_ID });
  });

  it('serializes the automatic pause decision date', async () => {
    h.findActive.mockResolvedValue([
      incident({
        autoPause: {
          mode: 'shadow',
          decidedAt: new Date('2026-11-17T10:05:00.000Z'),
          tier: 'standard',
          thresholdCredits: 10_000,
          valueCredits: 12_000,
        },
      }),
    ]);

    const body = (await run())._getJSONData();

    expect(body.incidents[0].autoPause).toMatchObject({ mode: 'shadow', decidedAt: '2026-11-17T10:05:00.000Z' });
  });

  it('sums platform credits over the hour and day ending with the newest bucket', async () => {
    h.sumWindow.mockImplementation(
      async (_scope: string, from: Date, to: Date) =>
        new Map([['all', { credits: to.getTime() - from.getTime() === 3_600_000 ? 120 : 2_400 }]])
    );

    const body = (await run())._getJSONData();

    expect(body.platform).toEqual({
      lastHourCredits: 120,
      last24hCredits: 2_400,
      latestBucketStart: '2026-11-17T12:00:00.000Z',
    });
    const [scope, from, to] = h.sumWindow.mock.calls[0];
    expect(scope).toBe('platform');
    expect((to as Date).toISOString()).toBe('2026-11-17T12:05:00.000Z');
    expect((from as Date).toISOString()).toBe('2026-11-17T11:05:00.000Z');
  });

  it('reports zero credits and no bucket before anything is rolled up', async () => {
    h.latestBucketStart.mockResolvedValue(null);

    const body = (await run())._getJSONData();

    expect(body.platform).toEqual({ lastHourCredits: 0, last24hCredits: 0, latestBucketStart: null });
  });

  it('reads the automatic pause settings', async () => {
    h.getSettingsMap.mockResolvedValue({
      spendMonitorAutoPauseMode: 'enforce',
      spendMonitorAutoPauseStandardMinCredits: '5000',
      spendMonitorAutoPausePaidMinCredits: '20000',
      spendMonitorAutoPauseTrustedMinCredits: '0',
    });

    const body = (await run())._getJSONData();

    expect(body.autoPause).toEqual({ mode: 'enforce', minCreditsByTier: { standard: 5000, paid: 20000, trusted: 0 } });
  });

  it('falls back to the default automatic pause settings', async () => {
    const body = (await run())._getJSONData();

    expect(body.autoPause).toEqual({ mode: 'shadow', minCreditsByTier: { standard: 10_000, paid: 0, trusted: 0 } });
  });
});
