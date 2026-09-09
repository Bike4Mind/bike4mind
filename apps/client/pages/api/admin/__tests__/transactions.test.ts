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

const mockVerifyOrgAccess = vi.fn();
vi.mock('@server/utils/orgAccess', () => ({
  verifyOrgAccess: (...a: unknown[]) => mockVerifyOrgAccess(...a),
}));

vi.mock('@server/utils/resolveUserNames', () => ({
  resolveUserNames: async () => new Map<string, string>(),
}));

import handler from '../transactions';

const ORG = '6650000000000000000000aa';

function call(options: { isAdmin?: boolean; hasUser?: boolean; query?: object }) {
  const { req, res } = createMocks({ method: 'GET', query: options.query ?? { organizationId: ORG } });
  if (options.hasUser !== false) {
    (req as unknown as { user: { isAdmin: boolean; id: string } }).user = {
      isAdmin: options.isAdmin ?? false,
      id: 'user-1',
    };
  }
  return { req, res, run: () => (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res) };
}

describe('GET /api/admin/transactions — access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyOrgAccess.mockResolvedValue({ id: ORG });
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

  it('gates access through verifyOrgAccess for the requested org', async () => {
    const { run } = call({ isAdmin: false });
    await run();
    expect(mockVerifyOrgAccess).toHaveBeenCalledWith({ id: 'user-1', isAdmin: false }, ORG);
  });

  it('propagates verifyOrgAccess denial and never queries the ledger', async () => {
    mockVerifyOrgAccess.mockRejectedValue(new NotFoundError('Organization not found'));
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
