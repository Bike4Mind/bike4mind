import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * DELETE /api/organizations/[id]/members (leave) returns the updated org, which
 * is written into the client query cache. It must be routed through
 * toSafeOrganization so a leaving member does not receive billing identifiers.
 */

const mockRefs = vi.hoisted(() => ({
  deleteHandler: null as null | ((req: any, res: any) => unknown),
}));

const assertDataLakeShareScope = vi.hoisted(() => vi.fn());
const lakeConfigAuditPrincipal = vi.hoisted(() => vi.fn(() => undefined as unknown));
vi.mock('@server/dataLakes/dataLakeScopes', () => ({
  assertDataLakeShareScope,
  DATA_LAKE_SHARE_SCOPES: ['datalake:share'],
}));
vi.mock('@server/dataLakes/lakeConfigAuditPrincipal', () => ({ lakeConfigAuditPrincipal }));

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
  return { baseApi: () => chain };
});

const leave = vi.hoisted(() =>
  vi.fn(async () => ({
    id: 'org1',
    userId: 'owner1',
    name: 'Acme',
    billingContact: 'billing@acme.com',
    stripeCustomerId: 'cus_SECRET',
  }))
);
vi.mock('@bike4mind/services', () => ({ organizationService: { leave } }));
// A factory must name every export the module graph reaches, or the missing binding throws. The
// lake repos the route passes to the service throw when the handler runs; the audit pair behind
// `lakeConfigAuditDb` throws at IMPORT time, taking the suite to zero tests.
vi.mock('@bike4mind/database', () => ({
  withTransaction: (fn: any) => fn(),
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  lakeConfigChangeEventRepository: {},
  adminSettingsRepository: {},
}));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: {} }));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: {} }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

import '@pages/api/organizations/[id]/members/index';

describe('DELETE /api/organizations/[id]/members (leave) - safe serialization', () => {
  beforeEach(() => {
    leave.mockClear();
    assertDataLakeShareScope.mockClear();
    assertDataLakeShareScope.mockImplementation(() => {});
    lakeConfigAuditPrincipal.mockClear();
    lakeConfigAuditPrincipal.mockReturnValue(undefined);
  });

  it('strips billing identifiers from the org returned to a leaving member', async () => {
    const { req, res } = createMocks({ method: 'DELETE', query: { id: 'org1' } });
    // A member (not the owner) leaving.
    (req as any).user = { id: 'member2', isAdmin: false };
    (req as any).ability = {};
    await mockRefs.deleteHandler!(req, res);

    const body = res._getJSONData();
    expect(body.name).toBe('Acme');
    expect('stripeCustomerId' in body).toBe(false);
    expect('billingContact' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('cus_SECRET');
  });

  // Leaving expires the member's grants on the org's lakes and can pass ownership of lakes they
  // created to the billing owner. A scope-less route is fail-OPEN, so before this any valid key
  // could do that. In-handler rather than on baseApi() so GET/POST keep their current behaviour.
  it('refuses a key without datalake:share BEFORE any membership write', async () => {
    assertDataLakeShareScope.mockImplementation(() => {
      throw new Error('This API key cannot change who can reach a data lake; datalake:share is required');
    });

    const { req, res } = createMocks({ method: 'DELETE', query: { id: 'org1' } });
    (req as any).user = { id: 'member2', isAdmin: false };
    (req as any).ability = {};
    (req as any).apiKeyInfo = { keyId: 'key-7', scopes: [] };

    await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow('datalake:share');
    expect(leave).not.toHaveBeenCalled();
  });

  it('threads the API-key audit principal and the logger into the departure', async () => {
    // Without the principal the lake audit rows record `principalKind: 'user'` and the key id is
    // lost, so a scripted departure reads as the member clicking Leave themselves.
    lakeConfigAuditPrincipal.mockReturnValue({
      principalKind: 'apiKey',
      principalId: 'key-7',
      onBehalfOfUserId: 'member2',
    });

    const { req, res } = createMocks({ method: 'DELETE', query: { id: 'org1' } });
    const user = { id: 'member2', isAdmin: false };
    const logger = { warn: vi.fn() };
    (req as any).user = user;
    (req as any).ability = {};
    (req as any).apiKeyInfo = { keyId: 'key-7', scopes: ['datalake:share'] };
    (req as any).logger = logger;

    await mockRefs.deleteHandler!(req, res);

    expect(lakeConfigAuditPrincipal).toHaveBeenCalledWith(user, { keyId: 'key-7', scopes: ['datalake:share'] });
    expect(leave).toHaveBeenCalledWith(
      user,
      expect.anything(),
      expect.objectContaining({
        auditPrincipal: { principalKind: 'apiKey', principalId: 'key-7', onBehalfOfUserId: 'member2' },
        logger,
      })
    );
  });
});
