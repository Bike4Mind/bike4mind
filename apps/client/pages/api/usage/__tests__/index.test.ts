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
const mockUsageTotalForOwner = vi.fn();
const mockFindByOrganizationId = vi.fn();
const mockFindByUserId = vi.fn();
vi.mock('@bike4mind/database', () => ({
  usageEventRepository: { ownerUsageSummary: (...a: unknown[]) => mockOwnerUsageSummary(...a) },
  creditTransactionRepository: {
    apiKeyUsageForOwner: (...a: unknown[]) => mockApiKeyUsageForOwner(...a),
    sourceUsageForOwner: (...a: unknown[]) => mockSourceUsageForOwner(...a),
    usageTotalForOwner: (...a: unknown[]) => mockUsageTotalForOwner(...a),
  },
  userApiKeyRepository: {
    findByOrganizationId: (...a: unknown[]) => mockFindByOrganizationId(...a),
    findByUserId: (...a: unknown[]) => mockFindByUserId(...a),
  },
}));

const mockVerifyOrgPermission = vi.fn();
vi.mock('@bike4mind/server-utils/utils/orgAccess', () => ({
  verifyOrgPermission: (...a: unknown[]) => mockVerifyOrgPermission(...a),
}));

vi.mock('@server/utils/resolveUserNames', () => ({
  resolveUserNames: async () => new Map<string, string>(),
}));

import handler from '../index';

const ORG = '6650000000000000000000aa';
const SELF = 'user-1';
const OTHER_USER = 'user-2';

function call(options: {
  isAdmin?: boolean;
  hasUser?: boolean;
  query?: object;
  adminPermissions?: string[];
  scopes?: string[];
}) {
  const { req, res } = createMocks({
    method: 'GET',
    query: options.query ?? { ownerType: 'Organization', ownerId: ORG },
  });
  if (options.hasUser !== false) {
    (req as unknown as { user: { isAdmin: boolean; id: string; adminPermissions?: string[] } }).user = {
      adminPermissions: options.adminPermissions,
      isAdmin: options.isAdmin ?? false,
      id: SELF,
    };
  }
  if (options.scopes) (req as unknown as { apiKeyInfo: { scopes: string[] } }).apiKeyInfo = { scopes: options.scopes };
  return { req, res, run: () => (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res) };
}

const emptySummary = {
  overTime: [],
  byMember: [],
  byProject: [],
  byModel: [],
  byFeature: [],
  totals: { requests: 0, cogsUsd: 0, creditsCharged: 0 },
};

describe('GET /api/usage - access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyOrgPermission.mockResolvedValue({ id: ORG, userId: SELF });
    mockOwnerUsageSummary.mockResolvedValue(emptySummary);
    mockApiKeyUsageForOwner.mockResolvedValue([]);
    mockSourceUsageForOwner.mockResolvedValue([]);
    mockUsageTotalForOwner.mockResolvedValue({ creditsCharged: 0, transactions: 0 });
    mockFindByOrganizationId.mockResolvedValue([]);
    mockFindByUserId.mockResolvedValue([]);
  });

  it('returns the ledger spend for the same owner and window as the usage events', async () => {
    mockUsageTotalForOwner.mockResolvedValue({ creditsCharged: 5069, transactions: 12 });
    const { res, run } = call({ isAdmin: true, query: { ownerType: 'User', ownerId: SELF, days: '7' } });

    await run();

    expect(mockUsageTotalForOwner).toHaveBeenCalledWith(SELF, 'User', 7);
    expect(mockOwnerUsageSummary).toHaveBeenCalledWith(SELF, 'User', 7);
    expect(res._getJSONData()).toMatchObject({ days: 7, totals: { requests: 0 }, ledger: { creditsCharged: 5069 } });
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
    it('returns manager-readable project usage without billing mutations', async () => {
      mockVerifyOrgPermission.mockResolvedValue({
        id: ORG,
        userId: 'owner',
        adminUserIds: [SELF],
        users: [{ userId: SELF }],
      });
      mockOwnerUsageSummary.mockResolvedValue({
        ...emptySummary,
        byProject: [{ projectId: null, requests: 1, creditsCharged: 3, cogsUsd: 0.01 }],
      });
      const { run, res } = call({ query: { ownerType: 'Organization', ownerId: ORG, days: '7' } });
      await run();
      expect(mockVerifyOrgPermission).toHaveBeenCalledWith({ id: SELF, isAdmin: false }, ORG, 'viewUsage');
      expect(mockOwnerUsageSummary).toHaveBeenCalledWith(ORG, 'Organization', 7);
      expect(res._getJSONData().byProject).toEqual([
        { projectId: null, requests: 1, creditsCharged: 3, cogsUsd: 0.01 },
      ]);
    });

    it('gates access through verifyOrgPermission for the requested org', async () => {
      const { run } = call({ isAdmin: false });
      await run();
      expect(mockVerifyOrgPermission).toHaveBeenCalledWith({ id: SELF, isAdmin: false }, ORG, 'viewUsage');
    });

    it('propagates verifyOrgPermission denial and never queries usage', async () => {
      mockVerifyOrgPermission.mockRejectedValue(new NotFoundError('Organization not found'));
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

    it('resolves an org-billed key name and prefix onto the by-API-key cut', async () => {
      mockApiKeyUsageForOwner.mockResolvedValue([
        { apiKeyId: 'key-1', requests: 5, creditsSpent: 10, inputTokens: 100, outputTokens: 50 },
      ]);
      mockFindByOrganizationId.mockResolvedValue([{ id: 'key-1', name: 'Org Key', keyPrefix: 'b4m_live_abcd' }]);
      const { res, run } = call({ isAdmin: false });
      await run();
      expect(res._getJSONData().byApiKey[0]).toMatchObject({ keyName: 'Org Key', keyPrefix: 'b4m_live_abcd' });
    });
  });

  describe('User owner', () => {
    it('lets a user read their own usage without org access', async () => {
      const { res, run } = call({ isAdmin: false, query: { ownerType: 'User', ownerId: SELF } });
      await run();
      expect(mockVerifyOrgPermission).not.toHaveBeenCalled();
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

    it("keeps a full admin's API key without the ADMIN scope able to read another user's usage", async () => {
      const { run } = call({ isAdmin: true, scopes: ['chat:read'], query: { ownerType: 'User', ownerId: OTHER_USER } });
      await run();
      expect(mockOwnerUsageSummary).toHaveBeenCalledWith(OTHER_USER, 'User', 30);
    });

    it("lets a support:read delegate read another user's usage", async () => {
      const { run } = call({
        isAdmin: false,
        adminPermissions: ['support:read'],
        query: { ownerType: 'User', ownerId: OTHER_USER },
      });
      await run();
      expect(mockOwnerUsageSummary).toHaveBeenCalledWith(OTHER_USER, 'User', 30);
    });

    it("refuses a delegate holding a different permission another user's usage", async () => {
      const { run } = call({
        isAdmin: false,
        adminPermissions: ['settings:manage'],
        query: { ownerType: 'User', ownerId: OTHER_USER },
      });
      await expect(run()).rejects.toThrow(/your own usage/i);
    });

    it('passes the org check once as read-only platform access for a support:read delegate', async () => {
      mockVerifyOrgPermission.mockResolvedValue({ id: ORG, userId: 'someone-else' });
      const { run } = call({ isAdmin: false, adminPermissions: ['support:read'] });
      await run();
      expect(mockVerifyOrgPermission).toHaveBeenCalledTimes(1);
      expect(mockVerifyOrgPermission).toHaveBeenCalledWith({ id: SELF, isAdmin: true }, ORG, 'viewUsage');
    });

    it('omits key names and prefixes from a delegate org view', async () => {
      mockVerifyOrgPermission.mockResolvedValue({ id: ORG, userId: 'someone-else' });
      mockApiKeyUsageForOwner.mockResolvedValue([
        { apiKeyId: 'key-1', requests: 5, creditsSpent: 10, inputTokens: 100, outputTokens: 50 },
      ]);
      mockFindByOrganizationId.mockResolvedValue([{ id: 'key-1', name: 'Org Key', keyPrefix: 'b4m_live_abcd' }]);
      const { res, run } = call({ isAdmin: false, adminPermissions: ['support:read'] });
      await run();
      expect(res._getJSONData().byApiKey[0].keyName).toBeUndefined();
      expect(res._getJSONData().byApiKey[0].keyPrefix).toBeUndefined();
    });

    it('still denies a delegate with a bad org id', async () => {
      mockVerifyOrgPermission.mockRejectedValue(new NotFoundError('Organization not found'));
      const { run } = call({ isAdmin: false, adminPermissions: ['support:read'] });
      await expect(run()).rejects.toThrow(/not found/i);
      expect(mockOwnerUsageSummary).not.toHaveBeenCalled();
    });

    it('keeps key names for a delegate who owns the org', async () => {
      mockApiKeyUsageForOwner.mockResolvedValue([
        { apiKeyId: 'key-1', requests: 5, creditsSpent: 10, inputTokens: 100, outputTokens: 50 },
      ]);
      mockFindByOrganizationId.mockResolvedValue([{ id: 'key-1', name: 'Org Key', keyPrefix: 'b4m_live_abcd' }]);
      const { res, run } = call({ isAdmin: false, adminPermissions: ['support:read'] });
      await run();
      expect(res._getJSONData().byApiKey[0]).toMatchObject({ keyName: 'Org Key', keyPrefix: 'b4m_live_abcd' });
    });

    it('keeps key names for a full admin', async () => {
      mockVerifyOrgPermission.mockResolvedValue({ id: ORG, userId: 'someone-else' });
      mockApiKeyUsageForOwner.mockResolvedValue([
        { apiKeyId: 'key-1', requests: 5, creditsSpent: 10, inputTokens: 100, outputTokens: 50 },
      ]);
      mockFindByOrganizationId.mockResolvedValue([{ id: 'key-1', name: 'Org Key', keyPrefix: 'b4m_live_abcd' }]);
      const { res, run } = call({ isAdmin: true });
      await run();
      expect(res._getJSONData().byApiKey[0]).toMatchObject({ keyName: 'Org Key' });
    });

    it('denies a delegate API key without the ADMIN scope on both owner types', async () => {
      mockVerifyOrgPermission.mockRejectedValue(new NotFoundError('Organization not found'));
      const org = call({ isAdmin: false, adminPermissions: ['support:read'], scopes: ['chat:read'] });
      await expect(org.run()).rejects.toThrow(/not found/i);
      const user = call({
        isAdmin: false,
        adminPermissions: ['support:read'],
        scopes: ['chat:read'],
        query: { ownerType: 'User', ownerId: OTHER_USER },
      });
      await expect(user.run()).rejects.toThrow(/your own usage/i);
      expect(mockOwnerUsageSummary).not.toHaveBeenCalled();
    });

    it('allows a delegate API key that carries the ADMIN scope', async () => {
      const { run } = call({
        isAdmin: false,
        adminPermissions: ['support:read'],
        scopes: ['admin:*'],
        query: { ownerType: 'User', ownerId: OTHER_USER },
      });
      await run();
      expect(mockOwnerUsageSummary).toHaveBeenCalledWith(OTHER_USER, 'User', 30);
    });
  });
});
