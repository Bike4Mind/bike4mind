import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { NotFoundError } from '@bike4mind/utils';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const handlers: Record<string, (req: unknown, res: unknown) => Promise<unknown>> = {};
    const chain = async (req: { method: string }, res: unknown) => handlers[req.method](req, res);
    chain.use = () => chain;
    chain.get = (fn: (typeof handlers)[string]) => {
      handlers.GET = fn;
      return chain;
    };
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

const mockVerifyOrgAccess = vi.fn();
vi.mock('@server/utils/orgAccess', () => ({
  verifyOrgAccess: (...a: unknown[]) => mockVerifyOrgAccess(...a),
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
    mockVerifyOrgAccess.mockResolvedValue({ id: ORG });
    mockSessionBelongsToOwner.mockResolvedValue(true);
    mockSessionUsageSummary.mockResolvedValue(emptyUsage);
    mockFindBillingBySessionId.mockResolvedValue([]);
  });

  it('lets an admin read the whole session cross-org (unscoped queries, no ownership probe)', async () => {
    const { res, run } = call({ isAdmin: true });
    await run();
    expect(mockVerifyOrgAccess).not.toHaveBeenCalled();
    expect(mockSessionBelongsToOwner).not.toHaveBeenCalled();
    // No owner filter: admins see the full cross-org rollup.
    expect(mockSessionUsageSummary).toHaveBeenCalledWith(SESSION, undefined);
    expect(mockFindBillingBySessionId).toHaveBeenCalledWith(SESSION, undefined);
    expect(res._getJSONData().sessionId).toBe(SESSION);
  });

  it('rejects a non-admin who omits the organization', async () => {
    const { run } = call({ isAdmin: false });
    await expect(run()).rejects.toThrow(/[Aa]dmin/);
    expect(mockSessionUsageSummary).not.toHaveBeenCalled();
  });

  it('scopes an org owner to their org slice of the session (no cross-owner leak)', async () => {
    const { res, run } = call({ isAdmin: false, query: { sessionId: SESSION, organizationId: ORG } });
    await run();
    expect(mockVerifyOrgAccess).toHaveBeenCalledWith({ id: 'user-1', isAdmin: false }, ORG);
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

  it('propagates verifyOrgAccess denial before probing ownership', async () => {
    mockVerifyOrgAccess.mockRejectedValue(new NotFoundError('Organization not found'));
    const { run } = call({ isAdmin: false, query: { sessionId: SESSION, organizationId: ORG } });
    await expect(run()).rejects.toThrow(/not found/i);
    expect(mockSessionBelongsToOwner).not.toHaveBeenCalled();
  });
});
