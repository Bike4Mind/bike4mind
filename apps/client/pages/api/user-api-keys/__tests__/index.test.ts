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
// findIdsAdministeredBy stays (GET org-list + POST org-billing auth use it);
// findById is added because the owner-scoped gate + GET now resolve owners.
const userRepository = vi.hoisted(() => ({ findById: vi.fn().mockResolvedValue({ id: 'owner' }) }));
const organizationFindById = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({
  organizationRepository: { findIdsAdministeredBy, findById: organizationFindById },
  userRepository,
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

// The real gateEmbedBrandingWrite AND embedKeyOwnerHasEntitlement run; only the
// leaf entitlement source (getUserEntitlements) is stubbed, so these tests
// exercise the actual OWNER-scoped strip logic through the route (#891).
const getUserEntitlements = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('@server/entitlements', () => ({ getUserEntitlements }));

import { CreditHolderType } from '@bike4mind/common';
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

  // Post-#891 the mint gate is OWNER-scoped: the new key's billing owner (the
  // minter for a personal key, the org billing owner for an org-billed key)
  // decides, not the acting caller - so an admin minting a key for an unentitled
  // owner cannot persist a hideBranding the read side would strip.
  describe('whitelabel write gate - owner-scoped (#891)', () => {
    const mintBody = (branding: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      name: 'widget',
      scopes: ['embed:chat'],
      agentId: 'agent-1',
      branding,
      ...extra,
    });

    beforeEach(() => {
      getUserEntitlements.mockReset();
      getUserEntitlements.mockResolvedValue([]); // owner not entitled by default
      userRepository.findById.mockReset();
      userRepository.findById.mockResolvedValue({ id: 'u1' });
      organizationFindById.mockReset();
      findIdsAdministeredBy.mockReset();
      findIdsAdministeredBy.mockResolvedValue([]);
    });

    it('strips hideBranding:true when the new key owner is unentitled, keeping other fields', async () => {
      const { req, res } = post(mintBody({ displayName: 'Acme', hideBranding: true }));
      await mockRefs.postHandler!(req, res);
      expect(res._getStatusCode()).toBe(201);
      expect(getUserEntitlements).toHaveBeenCalled();
      expect(createUserApiKey).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ branding: { displayName: 'Acme', hideBranding: false } }),
        expect.anything()
      );
    });

    it('preserves hideBranding:true when the new key owner is entitled', async () => {
      getUserEntitlements.mockResolvedValue(['embed:whitelabel']);
      const { req, res } = post(mintBody({ hideBranding: true }));
      await mockRefs.postHandler!(req, res);
      expect(createUserApiKey).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ branding: { hideBranding: true } }),
        expect.anything()
      );
    });

    it('strips hideBranding when owner resolution rejects (fail closed)', async () => {
      userRepository.findById.mockRejectedValue(new Error('lookup down'));
      const { req, res } = post(mintBody({ hideBranding: true }));
      await mockRefs.postHandler!(req, res);
      expect(createUserApiKey).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ branding: { hideBranding: false } }),
        expect.anything()
      );
    });

    it('never resolves the owner for branding without a hideBranding elevation', async () => {
      const { req, res } = post(mintBody({ primaryColor: '#336699' }));
      await mockRefs.postHandler!(req, res);
      expect(getUserEntitlements).not.toHaveBeenCalled();
      expect(createUserApiKey).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ branding: { primaryColor: '#336699' } }),
        expect.anything()
      );
    });

    // Org-billed mint by an admin: the entitlement is the ORG billing owner's,
    // not the admin minter's - so an admin (entitled or not) cannot white-label
    // an unentitled org's key. Closes the "admin mints an org key" hole.
    it('resolves the ORG billing owner (not the admin minter) for an org-billed mint', async () => {
      organizationFindById.mockResolvedValue({ userId: 'org-owner' });
      userRepository.findById.mockImplementation(async (id: string) => ({ id }));
      getUserEntitlements.mockImplementation(async (owner: any) => (owner?.id === 'u1' ? ['embed:whitelabel'] : []));
      const { req, res } = post(mintBody({ hideBranding: true }, { organizationId: 'org-1' }));
      (req as any).user = { id: 'u1', isAdmin: true }; // admin may bill any org
      await mockRefs.postHandler!(req, res);
      expect(organizationFindById).toHaveBeenCalledWith('org-1');
      expect(createUserApiKey).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ branding: { hideBranding: false }, billingOwnerType: CreditHolderType.Organization }),
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

/**
 * List route computes `ownerHasWhitelabel` per embed key (#891) so the Configure
 * UI gates the toggle on the OWNER's plan, not the viewer's. The finders return
 * hydrated Mongoose docs whose toJSON emits only schema paths, so the handler
 * must serialize BEFORE attaching the computed field - the fixture below mimics
 * that (own props != toJSON output) to guard the serialize-first requirement.
 */
describe('GET /api/user-api-keys - ownerHasWhitelabel (#891)', () => {
  // A doc the handler reads directly (id/scopes/userId/billing*) via own props,
  // but whose response body comes only from toJSON - which emits an extra
  // `serialized` marker absent from the own props. A handler that spread the doc
  // instead of serializing would drop `serialized`, failing the assertion.
  const hydrated = (own: Record<string, unknown>) => ({ ...own, toJSON: () => ({ ...own, serialized: true }) });

  beforeEach(() => {
    listUserApiKeys.mockReset();
    listOrganizationApiKeys.mockReset().mockResolvedValue([]);
    findIdsAdministeredBy.mockReset().mockResolvedValue([]);
    getUserEntitlements
      .mockReset()
      .mockImplementation(async (owner: any) => (owner?.id === 'ownerA' ? ['embed:whitelabel'] : []));
    userRepository.findById.mockReset().mockImplementation(async (id: string) => ({ id }));
  });

  function get() {
    const { req, res } = createMocks({ method: 'GET', query: {} });
    (req as any).user = { id: 'u1' };
    (res as any).json = vi.fn();
    return { req, res };
  }

  it('attaches ownerHasWhitelabel per embed key by owner, and omits it for non-embed keys', async () => {
    listUserApiKeys.mockResolvedValue([
      hydrated({ id: 'k-entitled', scopes: ['embed:chat'], userId: 'ownerA' }),
      hydrated({ id: 'k-unentitled', scopes: ['embed:chat'], userId: 'ownerB' }),
      hydrated({ id: 'k-plain', scopes: ['notebooks:read'], userId: 'ownerA' }),
    ]);
    const { req, res } = get();
    await mockRefs.getHandler!(req, res);

    const payload = (res as any).json.mock.calls[0][0];
    const byId = Object.fromEntries(payload.map((k: any) => [k.id, k]));
    // Serialized via toJSON (not a raw doc spread), so the marker survives.
    expect(byId['k-entitled'].serialized).toBe(true);
    expect(byId['k-entitled'].ownerHasWhitelabel).toBe(true);
    expect(byId['k-unentitled'].ownerHasWhitelabel).toBe(false);
    // Non-embed key: no owner lookup, field omitted entirely.
    expect(byId['k-plain']).not.toHaveProperty('ownerHasWhitelabel');
  });

  it('resolves each distinct owner once even across many keys (per-owner cache)', async () => {
    listUserApiKeys.mockResolvedValue([
      hydrated({ id: 'k1', scopes: ['embed:chat'], userId: 'ownerA' }),
      hydrated({ id: 'k2', scopes: ['embed:chat'], userId: 'ownerA' }),
      hydrated({ id: 'k3', scopes: ['embed:chat'], userId: 'ownerB' }),
    ]);
    const { req, res } = get();
    await mockRefs.getHandler!(req, res);
    // Two distinct owners -> two resolutions, not three.
    expect(userRepository.findById).toHaveBeenCalledTimes(2);
  });
});
