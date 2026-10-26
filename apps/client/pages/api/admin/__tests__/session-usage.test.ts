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
    const middleware: ((req: unknown, res: unknown, next: () => void) => unknown)[] = [];
    const chain = async (req: { method: string }, res: unknown) => {
      for (const guard of middleware) await guard(req, res, () => {});
      return handlers[req.method](req, res);
    };
    chain.use = (guard: (typeof middleware)[number]) => {
      middleware.push(guard);
      return chain;
    };

    chain.get = (fn: (typeof handlers)[string]) => {
      handlers.GET = fn;
      return chain;
    };
    chain._config = config;
    return chain;
  },
}));

const mockSessionUsageSummary = vi.fn();
const mockSessionBelongsToOwner = vi.fn();
const mockFindBillingBySessionId = vi.fn();
vi.mock('@bike4mind/database', () => ({
  usageEventRepository: {
    sessionUsageSummary: (...a: unknown[]) => mockSessionUsageSummary(...a),
    sessionBelongsToOwner: (...a: unknown[]) => mockSessionBelongsToOwner(...a),
  },
  agentExecutionRepository: { findBillingBySessionId: (...a: unknown[]) => mockFindBillingBySessionId(...a) },
}));

const mockVerifyOrgUsageRead = vi.fn();
vi.mock('@server/utils/adminUsageRead', () => ({
  verifyOrgUsageRead: (...a: unknown[]) => mockVerifyOrgUsageRead(...a),
}));

import handler from '../session-usage';

const ORG = '6650000000000000000000aa';
const SESSION = 'sess-1';

function call(options: { isAdmin?: boolean; hasUser?: boolean; query?: object }) {
  const { req, res } = createMocks({ method: 'GET', query: options.query ?? { sessionId: SESSION } });
  if (options.hasUser !== false) {
    (req as unknown as { user: { isAdmin: boolean; id: string } }).user = {
      isAdmin: options.isAdmin ?? false,
      id: 'user-1',
    };
  }
  return { req, res, run: () => (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res) };
}

const emptyUsage = {
  byQuest: [],
  byModel: [],
  totals: { requests: 0, cogsUsd: 0, creditsCharged: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
};

describe('GET /api/admin/session-usage — access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyOrgUsageRead.mockResolvedValue({ id: ORG });
    mockSessionBelongsToOwner.mockResolvedValue(true);
    mockSessionUsageSummary.mockResolvedValue(emptyUsage);
    mockFindBillingBySessionId.mockResolvedValue([]);
  });

  it('requires the ADMIN scope so an under-scoped admin-owned key is 403d by apiKeyAuth', () => {
    const config = (handler as unknown as { _config?: { requiredScopes?: string[] } })._config;
    expect(config?.requiredScopes).toEqual([ApiKeyScope.ADMIN]);
  });

  it('lets an admin read the whole session cross-org (unscoped queries, no ownership probe)', async () => {
    const { res, run } = call({ isAdmin: true });
    await run();
    expect(mockVerifyOrgUsageRead).not.toHaveBeenCalled();
    expect(mockSessionBelongsToOwner).not.toHaveBeenCalled();
    // No owner filter: admins see the full cross-org rollup.
    expect(mockSessionUsageSummary).toHaveBeenCalledWith(SESSION, undefined);
    expect(mockFindBillingBySessionId).toHaveBeenCalledWith(SESSION, undefined);
    expect(res._getJSONData().sessionId).toBe(SESSION);
  });

  it('rejects a non-admin who omits the organization', async () => {
    const { run } = call({ isAdmin: false });
    await expect(run()).rejects.toThrow(/Missing permission: support:read/);
    expect(mockSessionUsageSummary).not.toHaveBeenCalled();
  });

  it('scopes an org owner to their org slice of the session (no cross-owner leak)', async () => {
    const { res, run } = call({ isAdmin: false, query: { sessionId: SESSION, organizationId: ORG } });
    await run();
    expect(mockVerifyOrgUsageRead).toHaveBeenCalledWith({ id: 'user-1', isAdmin: false }, ORG);
    expect(mockSessionBelongsToOwner).toHaveBeenCalledWith(SESSION, ORG, 'Organization');
    // Both response queries owner-scoped to the org - a mixed-owner session must
    // not surface another owner's spend to a non-admin.
    expect(mockSessionUsageSummary).toHaveBeenCalledWith(SESSION, { ownerId: ORG, ownerType: 'Organization' });
    expect(mockFindBillingBySessionId).toHaveBeenCalledWith(SESSION, ORG);
    expect(res._getJSONData().sessionId).toBe(SESSION);
  });

  it('404s a session not billed to the org (no cross-org leakage)', async () => {
    mockSessionBelongsToOwner.mockResolvedValue(false);
    const { run } = call({ isAdmin: false, query: { sessionId: SESSION, organizationId: ORG } });
    await expect(run()).rejects.toThrow(/not found/i);
    expect(mockSessionUsageSummary).not.toHaveBeenCalled();
  });

  it('propagates verifyOrgUsageRead denial before probing ownership', async () => {
    mockVerifyOrgUsageRead.mockRejectedValue(new NotFoundError('Organization not found'));
    const { run } = call({ isAdmin: false, query: { sessionId: SESSION, organizationId: ORG } });
    await expect(run()).rejects.toThrow(/not found/i);
    expect(mockSessionBelongsToOwner).not.toHaveBeenCalled();
  });
});
