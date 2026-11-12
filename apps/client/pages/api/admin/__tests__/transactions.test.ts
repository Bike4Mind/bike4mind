import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { NotFoundError } from '@bike4mind/utils';
import { ApiKeyScope } from '@bike4mind/common';

// Captures the config so a test can assert requiredScopes: the scope gate lives in
// apiKeyAuth (real middleware, not exercised here), so asserting the handler is
// registered with it is the only guard available at this level.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const handlers: Record<string, (req: unknown, res: unknown) => Promise<unknown>> = {};
    const chain = async (req: { method: string }, res: unknown) => handlers[req.method](req, res);
    chain.use = () => chain;
    chain.get = (fn: (typeof handlers)[string]) => {
      handlers.GET = fn;
      return chain;
    };
    chain._config = config;
    return chain;
  },
}));

const mockQueryLedgerPage = vi.fn();
vi.mock('@bike4mind/database', () => ({
  creditTransactionRepository: { queryLedgerPage: (...a: unknown[]) => mockQueryLedgerPage(...a) },
}));

const mockVerifyOrgPermission = vi.fn();
vi.mock('@bike4mind/server-utils/utils/orgAccess', () => ({
  verifyOrgPermission: (...a: unknown[]) => mockVerifyOrgPermission(...a),
}));

vi.mock('@server/utils/resolveUserNames', () => ({
  resolveUserNames: async () => new Map<string, string>(),
}));

import handler from '../transactions';

const ORG = '6650000000000000000000aa';

function call(options: { isAdmin?: boolean; adminPermissions?: string[]; hasUser?: boolean; query?: object }) {
  const { req, res } = createMocks({ method: 'GET', query: options.query ?? { organizationId: ORG } });
  if (options.hasUser !== false) {
    (req as unknown as { user: { isAdmin: boolean; adminPermissions?: string[]; id: string } }).user = {
      isAdmin: options.isAdmin ?? false,
      adminPermissions: options.adminPermissions,
      id: 'user-1',
    };
  }
  return { req, res, run: () => (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res) };
}

describe('GET /api/admin/transactions — access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyOrgPermission.mockResolvedValue({ id: ORG });
    mockQueryLedgerPage.mockResolvedValue({ data: [], total: 0 });
  });

  it('requires the ADMIN scope so an under-scoped admin-owned key is 403d by apiKeyAuth', () => {
    const config = (handler as unknown as { _config?: { requiredScopes?: string[] } })._config;
    expect(config?.requiredScopes).toEqual([ApiKeyScope.ADMIN]);
  });

  it('rejects an unauthenticated request', async () => {
    const { run } = call({ hasUser: false });
    await expect(run()).rejects.toThrow();
    expect(mockQueryLedgerPage).not.toHaveBeenCalled();
  });

  it('gates access through verifyOrgPermission for the requested org', async () => {
    const { run } = call({ isAdmin: false });
    await run();
    expect(mockVerifyOrgPermission).toHaveBeenCalledWith({ id: 'user-1', isAdmin: false }, ORG, 'viewUsage');
  });

  it.each([
    ['a full admin', { isAdmin: true }, true],
    ['a support:read delegate', { adminPermissions: ['support:read'] }, true],
    ['a delegate holding a different permission', { adminPermissions: ['settings:manage'] }, false],
  ])('passes %s to verifyOrgPermission with admin reach %s', async (_label, user, adminReach) => {
    const { run } = call(user);
    await run();
    expect(mockVerifyOrgPermission).toHaveBeenCalledWith({ id: 'user-1', isAdmin: adminReach }, ORG, 'viewUsage');
  });

  it('propagates verifyOrgPermission denial and never queries the ledger', async () => {
    mockVerifyOrgPermission.mockRejectedValue(new NotFoundError('Organization not found'));
    const { run } = call({ isAdmin: false });
    await expect(run()).rejects.toThrow(/not found/i);
    expect(mockQueryLedgerPage).not.toHaveBeenCalled();
  });

  it('returns an owner-scoped ledger page once access is granted', async () => {
    const { res, run } = call({ isAdmin: false });
    await run();
    expect(mockQueryLedgerPage).toHaveBeenCalledWith(ORG, 'Organization', expect.any(Object));
    expect(res._getJSONData().organizationId).toBe(ORG);
  });
});
