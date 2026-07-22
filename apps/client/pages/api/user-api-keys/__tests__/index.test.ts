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

import '@pages/api/user-api-keys/index';

function post(body: unknown) {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as any).user = { id: 'u1', isAdmin: false };
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
