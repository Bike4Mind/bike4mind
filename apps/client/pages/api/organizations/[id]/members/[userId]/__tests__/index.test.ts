import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * DELETE /api/organizations/[id]/members/[userId] (admin removal).
 *
 * Removing a member expires their data-lake grants on the org's lakes and can mint an owner grant
 * for the billing owner, so this route now changes who can reach a data lake. Two things follow and
 * both are pinned here: the route must carry `datalake:share` (a scope-less `baseApi()` is
 * fail-OPEN - any valid key satisfied it), and a key-driven removal must be attributed to the KEY
 * rather than recorded as the admin acting directly.
 */

const mockRefs = vi.hoisted(() => ({
  deleteHandler: null as null | ((req: any, res: any) => unknown),
  baseApiOptions: undefined as unknown,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: () => chain,
    post: () => chain,
    delete: (fn: any) => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return {
    baseApi: (options?: unknown) => {
      mockRefs.baseApiOptions = options;
      return chain;
    },
  };
});

const revokeAccess = vi.hoisted(() =>
  vi.fn(async () => ({ id: 'org1', userId: 'owner1', name: 'Acme', stripeCustomerId: 'cus_SECRET' }))
);
const reportAndNotifyKeptPersonalLakeShares = vi.hoisted(() => vi.fn().mockResolvedValue(2));
vi.mock('@server/utils/keptPersonalLakeSharesNotifier', () => ({ reportAndNotifyKeptPersonalLakeShares }));
vi.mock('@bike4mind/services', () => ({ organizationService: { revokeAccess } }));

const lakeConfigAuditPrincipal = vi.hoisted(() => vi.fn(() => undefined as unknown));
vi.mock('@server/dataLakes/lakeConfigAuditPrincipal', () => ({ lakeConfigAuditPrincipal }));
vi.mock('@server/dataLakes/dataLakeScopes', () => ({
  DATA_LAKE_SHARE_SCOPES: ['datalake:share'],
  assertDataLakeShareScope: vi.fn(),
}));

// A factory must name every export the module graph reaches, or the missing binding throws. The
// audit pair behind `lakeConfigAuditDb` throws at IMPORT time, taking the suite to zero tests.
vi.mock('@bike4mind/database', () => ({
  withTransaction: (fn: any) => fn(),
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  lakeConfigChangeEventRepository: {},
  adminSettingsRepository: {},
}));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: {} }));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: {} }));
vi.mock('@bike4mind/database/social', () => ({ groupRepository: {} }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

import '@pages/api/organizations/[id]/members/[userId]/index';

const request = (over: Record<string, unknown> = {}) => {
  const { req, res } = createMocks({ method: 'DELETE', query: { id: 'org1', userId: 'member2' } });
  (req as any).user = { id: 'owner1', isAdmin: false };
  (req as any).ability = {};
  Object.assign(req as any, over);
  return { req, res };
};

describe('DELETE /api/organizations/[id]/members/[userId]', () => {
  beforeEach(() => {
    revokeAccess.mockClear();
    lakeConfigAuditPrincipal.mockClear();
    lakeConfigAuditPrincipal.mockReturnValue(undefined);
  });

  it('declares datalake:share at the door', () => {
    expect(mockRefs.baseApiOptions).toEqual({ requiredScopes: ['datalake:share'] });
  });

  it('attributes a key-driven removal to the KEY, keeping the human findable', async () => {
    lakeConfigAuditPrincipal.mockReturnValue({
      principalKind: 'apiKey',
      principalId: 'key-7',
      onBehalfOfUserId: 'owner1',
    });
    const logger = { warn: vi.fn() };
    const apiKeyInfo = { keyId: 'key-7', scopes: ['datalake:share'] };
    const { req, res } = request({ apiKeyInfo, logger });

    await mockRefs.deleteHandler!(req, res);

    expect(lakeConfigAuditPrincipal).toHaveBeenCalledWith((req as any).user, apiKeyInfo);
    expect(revokeAccess).toHaveBeenCalledWith(
      (req as any).user,
      expect.objectContaining({ userId: 'member2' }),
      expect.objectContaining({
        auditPrincipal: { principalKind: 'apiKey', principalId: 'key-7', onBehalfOfUserId: 'owner1' },
        logger,
      })
    );
  });

  it('passes no audit principal for a session caller, leaving the default derivation in place', async () => {
    const { req, res } = request();

    await mockRefs.deleteHandler!(req, res);

    expect(revokeAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ auditPrincipal: undefined })
    );
  });

  it('strips billing identifiers from the org it returns', async () => {
    const { req, res } = request();

    await mockRefs.deleteHandler!(req, res);

    const body = res._getJSONData();
    expect(body.name).toBe('Acme');
    expect('stripeCustomerId' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('cus_SECRET');
  });
});

describe('DELETE /api/organizations/[id]/members/[userId] - personal-lake shares kept', () => {
  it('reports and notifies once after the commit, and tells the admin only how many shares were kept', async () => {
    reportAndNotifyKeptPersonalLakeShares.mockClear();
    const { req, res } = request();

    await mockRefs.deleteHandler!(req, res);

    expect(reportAndNotifyKeptPersonalLakeShares).toHaveBeenCalledTimes(1);
    expect(reportAndNotifyKeptPersonalLakeShares).toHaveBeenCalledWith('member2', 'Acme', undefined);
    const body = res._getJSONData();
    expect(body.personalLakeSharesKept).toBe(2);
  });
});
