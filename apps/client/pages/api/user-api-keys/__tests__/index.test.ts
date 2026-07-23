import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Mint-route embed branching: the host-aware origin screen (validateEmbedKeyOrigins,
 * run for real here), the 400 on a bad origin, and the forward-when-present rule
 * that fixed the silent-drop bug. The service is mocked - these assertions are about
 * what the route screens and forwards, not the service's own invariants.
 */

// PUBLISH_HOST is read from SERVER_DOMAIN at module load, so set it before imports.
vi.hoisted(() => {
  process.env.SERVER_DOMAIN = 'bike4mind.com';
});

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: any, res: any) => unknown),
  getHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const createUserApiKey = vi.hoisted(() =>
  vi.fn((_userId?: unknown, params?: Record<string, unknown>) => ({
    id: 'key-1',
    keyPrefix: 'b4m_live_abc1234',
    key: 'b4m_live_secretsecret',
    status: 'active',
    billingOwnerType: 'User',
    ...(params ?? {}),
  }))
);
const listUserApiKeys = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const listOrganizationApiKeys = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const findIdsAdministeredBy = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('@bike4mind/services', () => ({
  userApiKeyService: { createUserApiKey, listUserApiKeys, listOrganizationApiKeys },
}));
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: {} }));
vi.mock('@bike4mind/database', () => ({ organizationRepository: { findIdsAdministeredBy } }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

// The real gateEmbedBrandingWrite runs; only its entitlement seam is stubbed,
// so these tests exercise the actual strip logic through the route.
const requestHasEntitlement = vi.hoisted(() => vi.fn().mockResolvedValue(false));
vi.mock('@server/entitlements', () => ({ requestHasEntitlement }));

import '@pages/api/user-api-keys/index';

function post(body: unknown, opts: { isAdmin?: boolean } = {}) {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as any).user = { id: 'u1', isAdmin: opts.isAdmin ?? false };
  return { req, res };
}

describe('POST /api/user-api-keys - embed-key minting', () => {
  beforeEach(() => createUserApiKey.mockClear());

  it('(a) mints a valid embed:chat key with normalized origins, agentId, and branding', async () => {
    const { req, res } = post({
      name: 'widget',
      scopes: ['embed:chat'],
      agentId: 'agent-1',
      allowedOrigins: ['https://example.com', 'https://Example.com', 'https://widgets.example.org'],
      branding: { displayName: 'Acme' },
    });
    await mockRefs.postHandler!(req, res);
    expect(res._getStatusCode()).toBe(201);
    expect(createUserApiKey).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({
        agentId: 'agent-1',
        // validateEmbedKeyOrigins lowercased + deduped before forwarding.
        allowedOrigins: ['https://example.com', 'https://widgets.example.org'],
        branding: { displayName: 'Acme' },
      }),
      expect.anything()
    );
  });

  it('(b) rejects a first-party (self) host origin with 400 and never calls the service', async () => {
    const { req, res } = post({
      name: 'self',
      scopes: ['embed:chat'],
      agentId: 'agent-1',
      allowedOrigins: ['https://app.bike4mind.com'],
    });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/Bike4Mind host/i);
    expect(createUserApiKey).not.toHaveBeenCalled();
  });

  it('(a2) forwards spendCap alongside the other embed fields', async () => {
    const { req, res } = post({
      name: 'capped widget',
      scopes: ['embed:chat'],
      agentId: 'agent-1',
      spendCap: 5000,
    });
    await mockRefs.postHandler!(req, res);
    expect(res._getStatusCode()).toBe(201);
    expect(createUserApiKey).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ agentId: 'agent-1', spendCap: 5000 }),
      expect.anything()
    );
  });

  it('(c2) a non-embed key carrying only spendCap still forwards it (service rejects, no silent drop)', async () => {
    const { req, res } = post({
      name: 'plain-capped',
      scopes: ['notebooks:read'],
      spendCap: 5000,
    });
    await mockRefs.postHandler!(req, res);
    expect(createUserApiKey).toHaveBeenCalledWith('u1', expect.objectContaining({ spendCap: 5000 }), expect.anything());
  });

  it('(c) regression guard: a non-embed key carrying allowedOrigins forwards them, not drops', async () => {
    const { req, res } = post({
      name: 'plain',
      scopes: ['notebooks:read'],
      allowedOrigins: ['https://example.com'],
    });
    await mockRefs.postHandler!(req, res);
    // The route forwards embed fields whenever present so the service can reject the
    // incoherent request; it must NOT silently drop them (the 5047b84a bug).
    expect(createUserApiKey).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ allowedOrigins: ['https://example.com'] }),
      expect.anything()
    );
  });

  it('(d) rejects a non-array allowedOrigins with 400 (not a 500 TypeError)', async () => {
    const { req, res } = post({
      name: 'bad',
      scopes: ['embed:chat'],
      agentId: 'agent-1',
      allowedOrigins: 'https://example.com',
    });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/must be an array/i);
    expect(createUserApiKey).not.toHaveBeenCalled();
  });

  // The service is mocked, so these prove the ROUTE screens branding itself
  // (validateEmbedBranding) rather than relying on the service re-validation.
  it('(e) rejects branding with a javascript: logo URL and never calls the service', async () => {
    const { req, res } = post({
      name: 'bad',
      scopes: ['embed:chat'],
      agentId: 'agent-1',
      branding: { logoUrl: 'javascript:alert(1)' },
    });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/Invalid branding/i);
    expect(createUserApiKey).not.toHaveBeenCalled();
  });

  it('(e2) rejects branding with a non-hex primaryColor and never calls the service', async () => {
    const { req, res } = post({
      name: 'bad',
      scopes: ['embed:chat'],
      agentId: 'agent-1',
      branding: { primaryColor: 'rgb(0,0,0)' },
    });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/Invalid branding/i);
    expect(createUserApiKey).not.toHaveBeenCalled();
  });

  describe('whitelabel write gate (epic #41 Phase D)', () => {
    const mintBody = (branding: Record<string, unknown>) => ({
      name: 'widget',
      scopes: ['embed:chat'],
      agentId: 'agent-1',
      branding,
    });

    beforeEach(() => {
      requestHasEntitlement.mockReset();
      requestHasEntitlement.mockResolvedValue(false);
    });

    it('strips hideBranding:true for an unentitled caller, keeping other fields', async () => {
      const { req, res } = post(mintBody({ displayName: 'Acme', hideBranding: true }));
      await mockRefs.postHandler!(req, res);
      expect(res._getStatusCode()).toBe(201);
      expect(createUserApiKey).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ branding: { displayName: 'Acme', hideBranding: false } }),
        expect.anything()
      );
    });

    it('preserves hideBranding:true for an entitled caller', async () => {
      requestHasEntitlement.mockResolvedValue(true);
      const { req, res } = post(mintBody({ hideBranding: true }));
      await mockRefs.postHandler!(req, res);
      expect(createUserApiKey).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ branding: { hideBranding: true } }),
        expect.anything()
      );
    });

    it('strips hideBranding when the entitlement lookup rejects (fail closed)', async () => {
      requestHasEntitlement.mockRejectedValue(new Error('lookup down'));
      const { req, res } = post(mintBody({ hideBranding: true }));
      await mockRefs.postHandler!(req, res);
      expect(createUserApiKey).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ branding: { hideBranding: false } }),
        expect.anything()
      );
    });

    it('never consults the entitlement for branding without a hideBranding elevation', async () => {
      const { req, res } = post(mintBody({ primaryColor: '#336699' }));
      await mockRefs.postHandler!(req, res);
      expect(requestHasEntitlement).not.toHaveBeenCalled();
      expect(createUserApiKey).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ branding: { primaryColor: '#336699' } }),
        expect.anything()
      );
    });
  });
});

/**
 * Org-billed minting authorization. Passing organizationId mints an org-owned key
 * (billingOwnerType: Organization) - required for embed keys. Only an org admin
 * (owner/manager) or a platform admin may bill an org; everyone else is rejected.
 * This branch became reachable from the admin embed-key UI, so lock its contract.
 */
describe('POST /api/user-api-keys - org-billed authorization', () => {
  beforeEach(() => {
    createUserApiKey.mockClear();
    findIdsAdministeredBy.mockResolvedValue([]);
  });

  it('lets a platform admin bill any org, forwarding Organization billing', async () => {
    findIdsAdministeredBy.mockResolvedValue([]);
    const { req, res } = post(
      { name: 'widget', scopes: ['embed:chat'], agentId: 'agent-1', organizationId: 'org-9' },
      { isAdmin: true }
    );
    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(201);
    expect(createUserApiKey).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ organizationId: 'org-9', billingOwnerType: 'Organization', agentId: 'agent-1' }),
      expect.anything()
    );
  });

  it('lets a non-admin bill an org they administer', async () => {
    findIdsAdministeredBy.mockResolvedValue(['org-1']);
    const { req, res } = post({ name: 'widget', scopes: ['embed:chat'], agentId: 'agent-1', organizationId: 'org-1' });
    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(201);
    expect(createUserApiKey).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ organizationId: 'org-1', billingOwnerType: 'Organization' }),
      expect.anything()
    );
  });

  it('rejects a non-admin billing an org they do not administer, without calling the service', async () => {
    findIdsAdministeredBy.mockResolvedValue([]);
    const { req, res } = post({ name: 'widget', scopes: ['embed:chat'], agentId: 'agent-1', organizationId: 'org-9' });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/permission/i);
    expect(createUserApiKey).not.toHaveBeenCalled();
  });
});

/**
 * List route: revoked keys must stay visible in the management UIs (#776). The
 * `includeDisabled` flag has to reach BOTH list calls - personal and org-billed -
 * or an org admin's revoked keys still vanish from the table.
 */
describe('GET /api/user-api-keys - revoked-key visibility', () => {
  beforeEach(() => {
    listUserApiKeys.mockClear();
    listOrganizationApiKeys.mockClear();
    findIdsAdministeredBy.mockResolvedValue(['org-1']);
  });

  function get(query: Record<string, string> = {}) {
    const { req, res } = createMocks({ method: 'GET', query });
    (req as any).user = { id: 'u1' };
    (res as any).json = vi.fn();
    return { req, res };
  }

  it('(a) threads includeDisabled=true to both the personal and org list calls', async () => {
    const { req, res } = get({ includeDisabled: 'true' });
    await mockRefs.getHandler!(req, res);

    expect(listUserApiKeys).toHaveBeenCalledWith('u1', expect.anything(), { includeDisabled: true });
    expect(listOrganizationApiKeys).toHaveBeenCalledWith('org-1', expect.anything(), { includeDisabled: true });
  });

  it('(b) defaults to active-only so the documented public API is unchanged', async () => {
    const { req, res } = get();
    await mockRefs.getHandler!(req, res);

    expect(listUserApiKeys).toHaveBeenCalledWith('u1', expect.anything(), { includeDisabled: false });
    expect(listOrganizationApiKeys).toHaveBeenCalledWith('org-1', expect.anything(), { includeDisabled: false });
  });
});
