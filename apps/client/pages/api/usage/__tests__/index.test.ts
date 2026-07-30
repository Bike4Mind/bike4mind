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
const mockFindByUserId = vi.fn();
vi.mock('@bike4mind/database', () => ({
  usageEventRepository: { ownerUsageSummary: (...a: unknown[]) => mockOwnerUsageSummary(...a) },
  creditTransactionRepository: {
    apiKeyUsageForOwner: (...a: unknown[]) => mockApiKeyUsageForOwner(...a),
    sourceUsageForOwner: (...a: unknown[]) => mockSourceUsageForOwner(...a),
  },
  userApiKeyRepository: {
    findByOrganizationId: (...a: unknown[]) => mockFindByOrganizationId(...a),
    findByUserId: (...a: unknown[]) => mockFindByUserId(...a),
  },
}));

const mockVerifyOrgAccess = vi.fn();
vi.mock('@server/utils/orgAccess', () => ({
  verifyOrgAccess: (...a: unknown[]) => mockVerifyOrgAccess(...a),
}));

vi.mock('@server/utils/resolveUserNames', () => ({
  resolveUserNames: async () => new Map<string, string>(),
}));

import handler from '../index';

const ORG = '6650000000000000000000aa';
const SELF = 'user-1';
const OTHER_USER = 'user-2';

function call(options: { isAdmin?: boolean; hasUser?: boolean; query?: object }) {
  const { req, res } = createMocks({
    method: 'GET',
    query: options.query ?? { ownerType: 'Organization', ownerId: ORG },
  });
  if (options.hasUser !== false) {
    (req as unknown as { user: { isAdmin: boolean; id: string } }).user = {
      isAdmin: options.isAdmin ?? false,
      id: SELF,
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

describe('GET /api/usage - access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyOrgAccess.mockResolvedValue({ id: ORG });
    mockOwnerUsageSummary.mockResolvedValue(emptySummary);
    mockApiKeyUsageForOwner.mockResolvedValue([]);
    mockSourceUsageForOwner.mockResolvedValue([]);
    mockFindByOrganizationId.mockResolvedValue([]);
    mockFindByUserId.mockResolvedValue([]);
  });

  it('rejects an unauthenticated request', async () => {
    const { run } = call({ hasUser: false });
    await expect(run()).rejects.toThrow();
    expect(mockOwnerUsageSummary).not.toHaveBeenCalled();
  });

  it('rejects an unsupported owner type', async () => {
    const { run } = call({ query: { ownerType: 'Agent', ownerId: 'agent-1' } });
    await expect(run()).rejects.toThrow();
    expect(mockOwnerUsageSummary).not.toHaveBeenCalled();
  });

  describe('Organization owner', () => {
    it('gates access through verifyOrgAccess for the requested org', async () => {
      const { run } = call({ isAdmin: false });
      await run();
      expect(mockVerifyOrgAccess).toHaveBeenCalledWith({ id: SELF, isAdmin: false }, ORG);
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
      expect(mockFindByOrganizationId).toHaveBeenCalledWith(ORG);
      expect(res._getJSONData().ownerId).toBe(ORG);
      expect(res._getJSONData().ownerType).toBe('Organization');
    });
  });

  describe('User owner', () => {
    it('lets a user read their own usage without org access', async () => {
      const { res, run } = call({ isAdmin: false, query: { ownerType: 'User', ownerId: SELF } });
      await run();
      expect(mockVerifyOrgAccess).not.toHaveBeenCalled();
      expect(mockOwnerUsageSummary).toHaveBeenCalledWith(SELF, 'User', 30);
      expect(mockFindByUserId).toHaveBeenCalledWith(SELF);
      expect(res._getJSONData().ownerType).toBe('User');
    });

    it("rejects a non-admin reading another user's usage", async () => {
      const { run } = call({ isAdmin: false, query: { ownerType: 'User', ownerId: OTHER_USER } });
      await expect(run()).rejects.toThrow(/your own usage/i);
      expect(mockOwnerUsageSummary).not.toHaveBeenCalled();
    });

    it("lets an admin read another user's usage", async () => {
      const { run } = call({ isAdmin: true, query: { ownerType: 'User', ownerId: OTHER_USER } });
      await run();
      expect(mockOwnerUsageSummary).toHaveBeenCalledWith(OTHER_USER, 'User', 30);
    });
  });
});
