import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { NotFoundError } from '@bike4mind/utils';

// Middleware stripped so the handler body runs directly; the chain object
// doubles as the exported handler and dispatches on req.method.
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

const mockOwnerUsageSummary = vi.fn();
const mockApiKeyUsageForOwner = vi.fn();
const mockSourceUsageForOwner = vi.fn();
const mockFindByOrganizationId = vi.fn();
vi.mock('@bike4mind/database', () => ({
  usageEventRepository: { ownerUsageSummary: (...a: unknown[]) => mockOwnerUsageSummary(...a) },
  creditTransactionRepository: {
    apiKeyUsageForOwner: (...a: unknown[]) => mockApiKeyUsageForOwner(...a),
    sourceUsageForOwner: (...a: unknown[]) => mockSourceUsageForOwner(...a),
  },
  userApiKeyRepository: { findByOrganizationId: (...a: unknown[]) => mockFindByOrganizationId(...a) },
}));

const mockVerifyOrgAccess = vi.fn();
vi.mock('@server/utils/orgAccess', () => ({
  verifyOrgAccess: (...a: unknown[]) => mockVerifyOrgAccess(...a),
}));

vi.mock('@server/utils/resolveUserNames', () => ({
  resolveUserNames: async () => new Map<string, string>(),
}));

import handler from '../org-usage';

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

const emptySummary = {
  overTime: [],
  byMember: [],
  byModel: [],
  byFeature: [],
  totals: { requests: 0, cogsUsd: 0, creditsCharged: 0 },
};

describe('GET /api/admin/org-usage — access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyOrgAccess.mockResolvedValue({ id: ORG });
    mockOwnerUsageSummary.mockResolvedValue(emptySummary);
    mockApiKeyUsageForOwner.mockResolvedValue([]);
    mockSourceUsageForOwner.mockResolvedValue([]);
    mockFindByOrganizationId.mockResolvedValue([]);
  });

  it('rejects an unauthenticated request', async () => {
    const { run } = call({ hasUser: false });
    await expect(run()).rejects.toThrow();
    expect(mockOwnerUsageSummary).not.toHaveBeenCalled();
  });

  it('gates access through verifyOrgAccess for the requested org', async () => {
    const { run } = call({ isAdmin: false });
    await run();
    expect(mockVerifyOrgAccess).toHaveBeenCalledWith({ id: 'user-1', isAdmin: false }, ORG);
  });

  it('propagates verifyOrgAccess denial and never queries usage', async () => {
    mockVerifyOrgAccess.mockRejectedValue(new NotFoundError('Organization not found'));
    const { run } = call({ isAdmin: false });
    await expect(run()).rejects.toThrow(/not found/i);
    expect(mockOwnerUsageSummary).not.toHaveBeenCalled();
  });

  it('returns owner-scoped usage once access is granted', async () => {
    const { res, run } = call({ isAdmin: false });
    await run();
    expect(mockOwnerUsageSummary).toHaveBeenCalledWith(ORG, 'Organization', 30);
    expect(res._getJSONData().organizationId).toBe(ORG);
  });
});
