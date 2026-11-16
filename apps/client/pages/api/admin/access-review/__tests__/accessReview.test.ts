import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createMocks } from 'node-mocks-http';

type Handler = (req: Request, res: Response) => Promise<unknown>;
type Guard = (req: Request, res: Response, next: () => void) => void;
type Route = { options: unknown; guards: Guard[]; handlers: Record<string, Handler> };

const mocks = vi.hoisted(() => ({
  routes: [] as Route[],
  csrfGuard: ((_req: unknown, _res: unknown, next: () => void) => next()) as Guard,
  collect: vi.fn(),
  findByQuarter: vi.fn(),
  findLatestCompleted: vi.fn(),
  recordDecision: vi.fn(),
  ensureRecord: vi.fn(),
  markCompleted: vi.fn(),
  findById: vi.fn(),
  findAdmins: vi.fn(),
  findAudit: vi.fn(),
  findRoles: vi.fn(),
  audit: vi.fn(),
  deny: vi.fn(),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    const route: Route = { options, guards: [], handlers: {} };
    mocks.routes.push(route);
    const chain = {
      use: (guard: Guard) => {
        route.guards.push(guard);
        return chain;
      },
      get: (fn: Handler) => {
        route.handlers.GET = fn;
        return chain;
      },
      post: (fn: Handler) => {
        route.handlers.POST = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => mocks.csrfGuard }));
vi.mock('@bike4mind/server-utils/security/accessReview/accessReviewData', () => ({
  collectAccessReview: mocks.collect,
  ACCESS_REVIEW_ADMIN_FILTER: { admins: true },
}));
vi.mock('@bike4mind/database', () => ({
  User: { findById: mocks.findById, find: mocks.findAdmins },
  AdminAuditLogModel: { find: mocks.findAudit },
  adminRoleRepository: { findByIds: mocks.findRoles },
  adminAccessReviewRepository: {
    findByQuarter: mocks.findByQuarter,
    findLatestCompleted: mocks.findLatestCompleted,
    recordDecision: mocks.recordDecision,
    ensureRecord: mocks.ensureRecord,
    markCompleted: mocks.markCompleted,
  },
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>()),
  recordAdminActionFromRequest: mocks.audit,
  denySelfAdminAction: mocks.deny,
}));

await import('../report');
await import('../status');
await import('../decisions');
await import('../export');
const [report, status, decisions, exportRoute] = mocks.routes;

const REVIEWER = '650000000000000000000009';
const OTHER = '650000000000000000000001';
const DELEGATE = '650000000000000000000002';
const NOW = new Date();
const QUARTER = `${NOW.getUTCFullYear()}-Q${Math.floor(NOW.getUTCMonth() / 3) + 1}`;
const FULL_ADMIN = { id: REVIEWER, name: 'Rev', username: 'rev', isAdmin: true };

const admin = (userId: string, fields: Record<string, unknown> = {}) => ({
  userId,
  email: `${userId}@example.com`,
  username: `u${userId.slice(-1)}`,
  fullAdmin: false,
  permissions: ['support:read'],
  directPermissions: ['support:read'],
  adminRoleIds: [],
  status: 'active',
  lastActiveAt: null,
  lastAdminActionAt: NOW.toISOString(),
  lastSignInAt: NOW.toISOString(),
  mfaEnabled: true,
  grantedBy: { userId: REVIEWER, name: 'Rev', email: 'rev@example.com' },
  grantedAt: NOW.toISOString(),
  activeSessions: 1,
  trustedDevices: 0,
  passkeys: 0,
  oauthRefreshTokens: 0,
  bridgeDevices: 0,
  activeApiKeys: 0,
  ...fields,
});

const record = (fields: Record<string, unknown> = {}) => ({
  id: 'r1',
  quarter: QUARTER,
  dormantDays: 90,
  startedAt: NOW,
  startedBy: { userId: REVIEWER, name: 'Rev' },
  decisions: [],
  completedAt: null,
  completedBy: null,
  ...fields,
});

const call = async (
  route: Route,
  method: 'GET' | 'POST',
  {
    body,
    query = {},
    actor = FULL_ADMIN as Record<string, unknown>,
  }: { body?: unknown; query?: Record<string, string>; actor?: Record<string, unknown> } = {}
) => {
  const { req, res } = createMocks({ method, body, query });
  const request = Object.assign(req, { user: actor }) as unknown as Request;
  for (const guard of route.guards) guard(request, res as unknown as Response, () => {});
  await route.handlers[method](request, res as unknown as Response);
  return res;
};

const target = (fields: Record<string, unknown>) =>
  mocks.findById.mockReturnValue({
    select: () => ({ lean: async () => ({ name: 'Ada', email: 'ada@example.com', ...fields }) }),
  });
const auditRows = (rows: unknown[]) =>
  mocks.findAudit.mockReturnValue({ sort: () => ({ select: () => ({ lean: async () => rows }) }) });
const permissionsChange = (id: string, changes: { field: string; before: string[]; after: string[] }[]) => ({
  _id: id,
  action: 'user.permissions.updated',
  changes,
});
const currentAdmins = (ids: string[]) =>
  mocks.findAdmins.mockReturnValue({ lean: async () => ids.map(_id => ({ _id })) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.collect.mockResolvedValue({
    generatedAt: NOW.toISOString(),
    admins: [admin(OTHER)],
    apiKeys: [{ id: 'k1', name: 'sk-SEEDED-API-KEY-SECRET' }],
    supportAccess: [{ sessionId: 's1' }],
    impersonation: [],
  });
  mocks.findByQuarter.mockResolvedValue(null);
  mocks.findLatestCompleted.mockResolvedValue(null);
  mocks.recordDecision.mockImplementation(async (_q, _d, _r, entry) => ({
    record: record({ decisions: [entry] }),
    changed: true,
  }));
  mocks.markCompleted.mockImplementation(async () => record({ completedAt: NOW }));
  mocks.findRoles.mockResolvedValue([]);
  mocks.audit.mockResolvedValue({});
  mocks.deny.mockImplementation(async () => {
    throw Object.assign(new Error('denied'), { statusCode: 403 });
  });
  target({ isAdmin: false, adminPermissions: ['support:read'] });
  auditRows([]);
  currentAdmins([REVIEWER, OTHER]);
});

describe('access review routes', () => {
  it('are session-only behind settings:manage, and only the decision route takes a body, with csrf', () => {
    expect(report.options).toMatchObject({ auth: 'jwtOnly', allowedMethods: ['GET'] });
    expect(status.options).toMatchObject({ auth: 'jwtOnly', allowedMethods: ['GET'] });
    expect(exportRoute.options).toMatchObject({ auth: 'jwtOnly', allowedMethods: ['GET'] });
    expect(decisions.options).toMatchObject({ auth: 'jwtOnly', allowedMethods: ['POST'] });
    expect(decisions.guards).toContain(mocks.csrfGuard);
  });

  it.each([
    ['report', () => report, 'GET'],
    ['status', () => status, 'GET'],
    ['decisions', () => decisions, 'POST'],
    ['export', () => exportRoute, 'GET'],
  ] as const)('refuses a delegate holding settings:manage on %s', async (_name, route, method) => {
    const actor = { id: DELEGATE, name: 'Del', adminPermissions: ['settings:manage'] };
    await expect(
      call(route(), method, { actor, body: { userId: OTHER, decision: 'confirmed' } })
    ).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.findLatestCompleted).not.toHaveBeenCalled();
    expect(mocks.recordDecision).not.toHaveBeenCalled();
  });
});

describe('GET report', () => {
  it('returns admin rows with dormant and no-MFA flags and never the key or delegation lists', async () => {
    const old = new Date(NOW.getTime() - 120 * 86_400_000).toISOString();
    mocks.collect.mockResolvedValue({
      generatedAt: NOW.toISOString(),
      admins: [admin(OTHER, { lastAdminActionAt: old, mfaEnabled: false })],
      apiKeys: [{ id: 'k1' }],
      supportAccess: [{ sessionId: 's1' }],
      impersonation: [],
    });
    const res = await call(report, 'GET', { query: { dormantDays: '90' } });
    const body = res._getJSONData();
    expect(body).toMatchObject({ quarter: QUARTER, dormantDays: 90, record: null });
    expect(body.admins[0]).toMatchObject({ userId: OTHER, dormant: true, noMfa: true, decision: null });
    expect(Object.keys(body)).not.toEqual(expect.arrayContaining(['apiKeys']));
    expect(JSON.stringify(body)).not.toMatch(/apiKeys|supportAccess|impersonation/);
  });

  it('shows no decision on a listed admin whose earlier revoke was undone by a re-grant', async () => {
    mocks.findByQuarter.mockResolvedValue(
      record({ decisions: [{ userId: OTHER, decision: 'revoked', permissions: [], auditEntryId: 'audit-1' }] })
    );
    const res = await call(report, 'GET');
    expect(res._getJSONData().admins[0]).toMatchObject({ userId: OTHER, decision: null });
  });

  it.each(['', '0', 'abc', '366', '6', '30.5'])('rejects dormantDays=%j', async value => {
    await expect(call(report, 'GET', { query: { dormantDays: value } })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('defaults dormantDays to 90', async () => {
    const res = await call(report, 'GET');
    expect(res._getJSONData().dormantDays).toBe(90);
  });
});

describe('GET status', () => {
  it('reports this quarter completion from the review records only', async () => {
    mocks.findLatestCompleted.mockResolvedValue(record({ completedAt: NOW }));
    const res = await call(status, 'GET');
    expect(res._getJSONData()).toEqual({ quarter: QUARTER, overdue: false, completedAt: NOW.toISOString() });
    expect(mocks.collect).not.toHaveBeenCalled();
  });
});

describe('POST decisions', () => {
  it('denies a decision on your own access with a denied audit entry', async () => {
    await expect(call(decisions, 'POST', { body: { userId: REVIEWER, decision: 'confirmed' } })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mocks.deny).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'access_review.denied',
        attempted: 'access_review.confirmed',
        target: expect.objectContaining({ id: REVIEWER }),
      })
    );
    expect(mocks.recordDecision).not.toHaveBeenCalled();
  });

  it('denies an impersonating admin deciding on their own access', async () => {
    const actor = { ...FULL_ADMIN, id: OTHER, impersonatedBy: REVIEWER };
    await expect(
      call(decisions, 'POST', { actor, body: { userId: REVIEWER, decision: 'confirmed' } })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.recordDecision).not.toHaveBeenCalled();
  });

  it('refuses any decision while impersonating, even on a third admin', async () => {
    const actor = { ...FULL_ADMIN, id: DELEGATE, impersonatedBy: REVIEWER };
    await expect(
      call(decisions, 'POST', { actor, body: { userId: OTHER, decision: 'confirmed' } })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.deny).not.toHaveBeenCalled();
    expect(mocks.recordDecision).not.toHaveBeenCalled();
  });

  it.each([{ userId: '' }, { userId: 'not-hex' }, { userId: 'ABCDEF000000000000000001' }, { decision: 'maybe' }])(
    'rejects a malformed body %j',
    async patch => {
      await expect(
        call(decisions, 'POST', { body: { userId: OTHER, decision: 'confirmed', ...patch } })
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(mocks.recordDecision).not.toHaveBeenCalled();
    }
  );

  it('confirms a current admin with a snapshot of their access and an audit entry', async () => {
    const res = await call(decisions, 'POST', { body: { userId: OTHER, decision: 'confirmed' } });
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.recordDecision).toHaveBeenCalledWith(
      QUARTER,
      90,
      { userId: REVIEWER, name: 'Rev' },
      expect.objectContaining({ userId: OTHER, decision: 'confirmed', fullAdmin: false, permissions: ['support:read'] })
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'access_review.confirmed' })
    );
    expect(res._getJSONData()).toMatchObject({ completed: false, pending: 1, pendingSelf: true });
  });

  it('refuses to confirm an account that holds no admin access', async () => {
    target({ isAdmin: false, adminPermissions: [], adminRoleIds: [] });
    await expect(call(decisions, 'POST', { body: { userId: OTHER, decision: 'confirmed' } })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(mocks.recordDecision).not.toHaveBeenCalled();
  });

  it.each([
    { isAdmin: true, adminPermissions: [] },
    { isAdmin: false, adminPermissions: ['support:read'] },
    { isAdmin: false, adminPermissions: [], adminRoleIds: ['660000000000000000000001'] },
  ])('refuses a revoke while the account still holds admin access %j', async fields => {
    target(fields);
    auditRows([{ _id: 'a1', action: 'user.role.admin_revoked' }]);
    await expect(call(decisions, 'POST', { body: { userId: OTHER, decision: 'revoked' } })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(mocks.recordDecision).not.toHaveBeenCalled();
  });

  it('refuses a revoke with no removal on the audit log this quarter', async () => {
    target({ isAdmin: false, adminPermissions: [], adminRoleIds: [] });
    await expect(call(decisions, 'POST', { body: { userId: OTHER, decision: 'revoked' } })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(mocks.recordDecision).not.toHaveBeenCalled();
  });

  it('records a revoke once access is gone, citing the removal audit entry', async () => {
    target({ isAdmin: false, adminPermissions: [], adminRoleIds: [] });
    auditRows([permissionsChange('audit-1', [{ field: 'adminPermissions', before: ['support:read'], after: [] }])]);
    currentAdmins([REVIEWER]);
    const res = await call(decisions, 'POST', { body: { userId: OTHER, decision: 'revoked' } });
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.findAudit).toHaveBeenCalledWith(
      expect.objectContaining({ 'target.id': OTHER, occurredAt: { $gte: expect.any(Date) } })
    );
    expect(mocks.recordDecision).toHaveBeenCalledWith(
      QUARTER,
      90,
      expect.anything(),
      expect.objectContaining({ decision: 'revoked', auditEntryId: 'audit-1', permissions: ['support:read'] })
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'access_review.revoked' })
    );
  });

  it('records a revoke for an admin whose stored ids were all unlisted, from the clearing audit entry', async () => {
    target({ isAdmin: false, adminPermissions: [], adminRoleIds: [] });
    auditRows([
      permissionsChange('audit-legacy', [{ field: 'adminPermissions', before: ['retired:perm'], after: [] }]),
    ]);
    currentAdmins([REVIEWER]);
    const res = await call(decisions, 'POST', { body: { userId: OTHER, decision: 'revoked' } });
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.recordDecision).toHaveBeenCalledWith(
      QUARTER,
      90,
      expect.anything(),
      expect.objectContaining({ decision: 'revoked', auditEntryId: 'audit-legacy', permissions: [] })
    );
  });

  it('records a full admin who also held direct permissions as a full admin, from both removals', async () => {
    target({ isAdmin: false, adminPermissions: [], adminRoleIds: [] });
    auditRows([
      permissionsChange('audit-2', [
        { field: 'adminPermissions', before: ['users:moderate', 'users:read'], after: [] },
      ]),
      {
        _id: 'audit-1',
        action: 'user.role.admin_revoked',
        changes: [{ field: 'isAdmin', before: true, after: false }],
      },
    ]);
    await call(decisions, 'POST', { body: { userId: OTHER, decision: 'revoked' } });
    expect(mocks.recordDecision).toHaveBeenCalledWith(
      QUARTER,
      90,
      expect.anything(),
      expect.objectContaining({ fullAdmin: true, permissions: ['users:moderate'], auditEntryId: 'audit-2' })
    );
  });

  it('records a full-admin-only revoke from the role audit entry', async () => {
    target({ isAdmin: false, adminPermissions: [], adminRoleIds: [] });
    auditRows([{ _id: 'audit-1', action: 'user.role.admin_revoked' }]);
    await call(decisions, 'POST', { body: { userId: OTHER, decision: 'revoked' } });
    expect(mocks.recordDecision).toHaveBeenCalledWith(
      QUARTER,
      90,
      expect.anything(),
      expect.objectContaining({ fullAdmin: true, permissions: [], auditEntryId: 'audit-1' })
    );
  });

  it('snapshots the permissions a removed admin role carried, beside direct ones', async () => {
    const roleId = '660000000000000000000001';
    target({ isAdmin: false, adminPermissions: [], adminRoleIds: [] });
    auditRows([
      permissionsChange('audit-1', [
        { field: 'adminPermissions', before: ['support:read'], after: [] },
        { field: 'adminRoleIds', before: [roleId], after: [] },
      ]),
    ]);
    mocks.findRoles.mockResolvedValue([{ id: roleId, name: 'Billing', permissions: ['credits:adjust'] }]);
    await call(decisions, 'POST', { body: { userId: OTHER, decision: 'revoked' } });
    expect(mocks.findRoles).toHaveBeenCalledWith([roleId]);
    expect(mocks.recordDecision).toHaveBeenCalledWith(
      QUARTER,
      90,
      expect.anything(),
      expect.objectContaining({
        fullAdmin: false,
        permissions: expect.arrayContaining(['support:read', 'credits:adjust']),
      })
    );
  });

  it.each([
    [
      'a permissions update that granted',
      [permissionsChange('g1', [{ field: 'adminPermissions', before: [], after: ['users:read'] }])],
    ],
    ['a role grant', [{ _id: 'g1', action: 'user.role.admin_granted' }]],
    [
      'a removal followed by a grant',
      [
        permissionsChange('g2', [{ field: 'adminRoleIds', before: [], after: ['660000000000000000000001'] }]),
        permissionsChange('r1', [{ field: 'adminPermissions', before: ['users:read'], after: [] }]),
      ],
    ],
  ])('refuses %s as proof of a revoke', async (_label, rows) => {
    target({ isAdmin: false, adminPermissions: [], adminRoleIds: [] });
    auditRows(rows);
    await expect(call(decisions, 'POST', { body: { userId: OTHER, decision: 'revoked' } })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(mocks.recordDecision).not.toHaveBeenCalled();
  });

  it('writes no audit entry when the same decision is repeated', async () => {
    mocks.recordDecision.mockImplementation(async (_q, _d, _r, entry) => ({
      record: record({ decisions: [entry] }),
      changed: false,
    }));
    const res = await call(decisions, 'POST', { body: { userId: OTHER, decision: 'confirmed' } });
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.audit).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'access_review.confirmed' })
    );
  });

  it('creates the review record before the decision transaction', async () => {
    await call(decisions, 'POST', { body: { userId: OTHER, decision: 'confirmed' } });
    expect(mocks.ensureRecord).toHaveBeenCalledWith(QUARTER, 90, { userId: REVIEWER, name: 'Rev' });
    expect(mocks.ensureRecord.mock.invocationCallOrder[0]).toBeLessThan(mocks.findById.mock.invocationCallOrder[0]);
  });

  it('keeps an admin revoked earlier this quarter but holding access again pending', async () => {
    const revoked = { userId: OTHER, decision: 'revoked', permissions: [], auditEntryId: 'audit-1' };
    mocks.recordDecision.mockImplementation(async (_q, _d, _r, entry) => ({
      record: record({ decisions: [revoked, entry] }),
      changed: true,
    }));
    currentAdmins([OTHER, DELEGATE]);
    const res = await call(decisions, 'POST', { body: { userId: DELEGATE, decision: 'confirmed' } });
    expect(mocks.markCompleted).not.toHaveBeenCalled();
    expect(res._getJSONData()).toMatchObject({ completed: false, pending: 1 });
  });

  it('completes the review when the last current admin gets a decision', async () => {
    currentAdmins([OTHER]);
    const res = await call(decisions, 'POST', { body: { userId: OTHER, decision: 'confirmed' } });
    expect(mocks.markCompleted).toHaveBeenCalledWith(QUARTER, expect.any(Date), { userId: REVIEWER, name: 'Rev' });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'access_review.completed' })
    );
    expect(res._getJSONData()).toMatchObject({ completed: true, pending: 0, pendingSelf: false });
  });

  it('does not complete while another admin is undecided', async () => {
    await call(decisions, 'POST', { body: { userId: OTHER, decision: 'confirmed' } });
    expect(mocks.markCompleted).not.toHaveBeenCalled();
  });
});

describe('GET export', () => {
  it('writes the fixed header, escapes formula cells and carries no secret the snapshot holds', async () => {
    mocks.collect.mockResolvedValue({
      generatedAt: NOW.toISOString(),
      admins: [
        admin(OTHER, {
          email: '=HYPERLINK("http://evil.example")',
          totpSecret: 'SEEDED-TOTP-SECRET',
          backupCodes: ['SEEDED-BACKUP-CODE'],
          mfa: { totpSecret: 'SEEDED-TOTP-SECRET' },
        }),
      ],
      apiKeys: [{ id: 'k1', name: 'sk-SEEDED-API-KEY-SECRET', keyHash: 'SEEDED-HASH' }],
      supportAccess: [],
      impersonation: [],
    });
    mocks.findByQuarter.mockResolvedValue(
      record({
        decisions: [
          {
            userId: DELEGATE,
            email: 'gone@example.com',
            fullAdmin: false,
            permissions: ['credits:adjust'],
            decision: 'revoked',
            reviewer: { userId: REVIEWER, name: 'Rev' },
            decidedAt: NOW,
            auditEntryId: 'audit-1',
          },
        ],
      })
    );
    const res = await call(exportRoute, 'GET');
    const body = res._getData() as string;
    const [header, ...rows] = body.split('\n');
    expect(header).toBe(
      '"quarter","userId","email","username","fullAdmin","permissions","grantedBy","grantedAt","lastAdminActionAt","lastSignInAt","mfaEnabled","dormant","decision","reviewerName","reviewerUserId","decidedAt","reviewCompletedAt"'
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain(`"'=HYPERLINK(""http://evil.example"")"`);
    expect(rows[1]).toContain('"revoked"');
    expect(body).not.toMatch(/SEEDED|totp|backup|keyHash/i);
    expect(res.getHeader('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'access_review.exported' })
    );
  });

  it.each(['2026-Q5', 'Q1', '2026-q1'])('rejects quarter=%j', async quarter => {
    await expect(call(exportRoute, 'GET', { query: { quarter } })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('404s an earlier quarter with no record and never reads live admins for one', async () => {
    await expect(call(exportRoute, 'GET', { query: { quarter: '2000-Q1' } })).rejects.toMatchObject({
      statusCode: 404,
    });
    mocks.findByQuarter.mockResolvedValue(record({ quarter: '2000-Q1' }));
    await call(exportRoute, 'GET', { query: { quarter: '2000-Q1' } });
    expect(mocks.collect).not.toHaveBeenCalled();
  });
});
