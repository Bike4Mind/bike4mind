// @vitest-environment node
import { EventEmitter } from 'events';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks, type RequestMethod } from 'node-mocks-http';
import {
  ApiKeyScope,
  CustomMcpPolicySchema,
  McpConnectionSlugConflictError,
  PLATFORM_MCP_OWNER,
  type IMcpConnectionDocument,
  type McpApiKeyUpdate,
  type McpConnectionOwner,
  type McpConnectionSettingsUpdate,
} from '@bike4mind/common';
import type { CustomMcpContext } from '@bike4mind/server-utils/mcpConnections/customMcpAccess';

/**
 * The platform connector admin routes, and the user routes as they meet a platform connector,
 * driven through real routers, the real permission check and the real error handler. The
 * repository is an in-memory owner-scoped store and discovery is stubbed; the queries themselves
 * are exercised against a real mongod in McpConnectionModel.test.ts.
 */

type Doc = IMcpConnectionDocument;
type Stored = Record<string, unknown>;
type Handler = (req: unknown, res: unknown) => Promise<void>;

const h = vi.hoisted(() => ({
  baseApiOptions: [] as Array<Record<string, unknown>>,
  rateLimits: [] as Array<{ limit: number; bucket: string }>,
  store: new Map<string, Record<string, unknown>>(),
  nextId: 0,
  context: undefined as unknown,
  adminAudits: [] as Array<Record<string, unknown>>,
  makeSlugError: undefined as unknown as (slug: string) => Error,
}));

vi.mock('@server/middlewares/baseApi', async () => {
  const nc = (await import('next-connect')).default;
  const errorHandler = (
    await vi.importActual<typeof import('@server/middlewares/errorHandler')>('@server/middlewares/errorHandler')
  ).default;
  return {
    baseApi: (options: Record<string, unknown>) => {
      h.baseApiOptions.push(options);
      return nc({ onError: errorHandler });
    },
  };
});
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (options: { limit: number; bucket: string }) => {
    h.rateLimits.push(options);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
vi.mock('@server/middlewares/perUserRateLimit', () => ({
  perUserRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/server-utils/mcpConnections/customMcpAccess', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/server-utils/mcpConnections/customMcpAccess')>();
  const { ForbiddenError } = await import('@bike4mind/common');
  return {
    ...actual,
    resolveCustomMcpContext: vi.fn(async () => h.context),
    assertCustomMcpEnabled: vi.fn(async () => {
      if (!(h.context as CustomMcpContext).enabled) throw new ForbiddenError('Custom MCP connectors are disabled');
      return h.context;
    }),
  };
});
vi.mock('@bike4mind/server-utils/middlewares/featureFlag', () => ({ isFeatureEnabled: vi.fn(async () => true) }));
vi.mock('@bike4mind/services', () => ({ scopedSettingsService: {} }));
vi.mock('sst', () => ({ Resource: {} }));
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({
  recordCircuitBreakerRejection: vi.fn(async () => undefined),
  recordCircuitBreakerTransition: vi.fn(async () => undefined),
}));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({
  encryptToken: (value: string | null | undefined) => (value ? `enc:${Buffer.from(value).toString('base64')}` : null),
  decryptToken: (value: string | null | undefined) => value,
}));
vi.mock('@bike4mind/server-utils/integrations/integrationAuditLogger', () => ({
  IntegrationAuditLogger: {
    create: () => ({ success: () => undefined, failure: () => undefined, rateLimited: () => undefined }),
  },
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  recordAdminActionFromRequest: vi.fn(async (_req: unknown, input: Record<string, unknown>) => {
    h.adminAudits.push(input);
    return null;
  }),
}));

const discover = vi.hoisted(() => vi.fn());
vi.mock('@server/mcpConnections/discovery', () => ({ discoverConnectionTools: discover }));

/** Default reads deselect the secrets, as the real repository does. */
function defaultRead(doc: Stored | undefined): Doc | null {
  if (!doc) return null;
  const copy = structuredClone(doc) as unknown as Doc;
  delete copy.urlEnc;
  if (copy.auth.apiKey) delete copy.auth.apiKey.valueEnc;
  return copy;
}

/** List reads leave the input schemas out as well. */
function summaryRead(doc: Stored): Doc {
  const copy = defaultRead(doc)!;
  return { ...copy, tools: copy.tools.map(({ inputSchema: _schema, ...tool }) => tool) } as Doc;
}

const owned = (id: string, owner: McpConnectionOwner): Stored | undefined => {
  const doc = h.store.get(id);
  return doc && doc.ownerType === owner.ownerType && doc.ownerKey === owner.ownerKey ? doc : undefined;
};
const rowsOf = (owner: McpConnectionOwner): Stored[] =>
  [...h.store.values()].filter(doc => doc.ownerType === owner.ownerType && doc.ownerKey === owner.ownerKey);

const repo = vi.hoisted(() => ({
  create: vi.fn(),
  createWithinUserCap: vi.fn(),
  findByIdForOwner: vi.fn(),
  findByIdWithCredentials: vi.fn(),
  listAllForUser: vi.fn(),
  listPlatform: vi.fn(),
  listPlatformSlugs: vi.fn(),
  updateSettings: vi.fn(),
  setStatus: vi.fn(),
  setApiKey: vi.fn(),
  clearOAuthTokens: vi.fn(),
  deleteForOwner: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({ mcpConnectionRepository: repo, cacheRepository: {} }));

function installRepo(): void {
  const insert = async (data: Stored) => {
    const owner = { ownerType: data.ownerType, ownerKey: data.ownerKey } as McpConnectionOwner;
    if (rowsOf(owner).some(doc => doc.slug === data.slug)) throw h.makeSlugError(String(data.slug));
    h.nextId += 1;
    const id = h.nextId.toString(16).padStart(24, '0');
    const now = new Date();
    h.store.set(id, { ...structuredClone(data), id, createdAt: now, updatedAt: now });
    return defaultRead(h.store.get(id));
  };
  repo.create.mockImplementation(insert);
  repo.createWithinUserCap.mockImplementation(insert);
  repo.findByIdForOwner.mockImplementation(async (id: string, owner: McpConnectionOwner) =>
    defaultRead(owned(id, owner))
  );
  repo.findByIdWithCredentials.mockImplementation(async (id: string, owner: McpConnectionOwner) => {
    const doc = owned(id, owner);
    return doc ? (structuredClone(doc) as unknown as Doc) : null;
  });
  repo.listAllForUser.mockImplementation(async (userId: string) =>
    rowsOf({ ownerType: 'user', ownerKey: userId }).map(summaryRead)
  );
  repo.listPlatform.mockImplementation(async () => rowsOf(PLATFORM_MCP_OWNER).map(summaryRead));
  repo.listPlatformSlugs.mockImplementation(async () => rowsOf(PLATFORM_MCP_OWNER).map(doc => doc.slug));
  repo.updateSettings.mockImplementation(
    async (id: string, owner: McpConnectionOwner, { tools: settings, ...rest }: McpConnectionSettingsUpdate) => {
      const doc = owned(id, owner);
      if (!doc) return null;
      const tools = (doc.tools as Doc['tools']).map(tool => {
        const { versionHash: _reviewed, ...choices } = settings?.find(entry => entry.name === tool.name) ?? {};
        return { ...tool, ...choices };
      });
      Object.assign(doc, rest, { tools });
      return defaultRead(doc);
    }
  );
  repo.setApiKey.mockImplementation(async (id: string, owner: McpConnectionOwner, apiKey: McpApiKeyUpdate) => {
    const doc = owned(id, owner);
    if (!doc || (doc.auth as Doc['auth']).kind !== 'api_key') return null;
    doc.auth = { kind: 'api_key', apiKey };
    return defaultRead(doc);
  });
  repo.setStatus.mockImplementation(async (id: string, status: string) => {
    const doc = h.store.get(id);
    if (!doc) return null;
    doc.status = status;
    return defaultRead(doc);
  });
  repo.clearOAuthTokens.mockImplementation(async (id: string, owner: McpConnectionOwner) =>
    defaultRead(owned(id, owner))
  );
  repo.deleteForOwner.mockImplementation(async (id: string, owner: McpConnectionOwner) =>
    owned(id, owner) ? h.store.delete(id) : false
  );
}

const ADMIN = { id: 'admin-1', organizationId: null, isAdmin: true };
const READER = { id: 'reader-1', organizationId: null, isAdmin: false, adminPermissions: ['support:read'] };
const USER = { id: 'user-1', organizationId: null, isAdmin: false };
const API_KEY = 'key_SUPERSECRET_0123456789';
const NEW_KEY = 'key_ROTATED_abcdefghijkl';
const quietLogger = { warn: () => undefined, error: () => undefined, info: () => undefined, debug: () => undefined };

const context = (overrides: Partial<CustomMcpContext> = {}): CustomMcpContext => ({
  enabled: true,
  policies: [CustomMcpPolicySchema.parse({ mode: 'presets_only' })],
  platformBlockedHosts: [],
  organizationIds: [],
  network: { ownHosts: ['app.example.com'] },
  maxConnectionsPerUser: 20,
  ...overrides,
});
const anyHost = () => context({ policies: [CustomMcpPolicySchema.parse({ mode: 'any' })] });

type RouteName = 'collection' | 'item' | 'refresh' | 'apiKey';
const admin = {} as Record<RouteName, Handler>;
const user = {} as Record<RouteName | 'oauthStart' | 'oauthDisconnect', Handler>;

async function call(
  handler: Handler,
  { method, as = ADMIN, id, body }: { method: RequestMethod; as?: unknown; id?: string; body?: unknown }
): Promise<{ status: number; body: unknown; raw: string }> {
  // next-connect resolves once the response emits `finish`, which needs a real emitter.
  const { req, res } = createMocks(
    { method, url: '/api', query: id ? { id } : {}, body: body as Record<string, unknown> },
    { eventEmitter: EventEmitter }
  );
  Object.assign(req, { user: as, logger: quietLogger, requestId: 'req-1' });
  await handler(req, res);
  const raw = String(res._getData() ?? '');
  return { status: res._getStatusCode(), body: res._isJSON() ? res._getJSONData() : raw, raw };
}

const createBody = (overrides: Record<string, unknown> = {}) => ({
  url: 'https://mcp.example.com/team/abcdefghijklmnopqrstWXYZ/mcp',
  displayName: 'Docs',
  auth: { kind: 'api_key', value: API_KEY },
  ...overrides,
});

async function createPlatform(overrides: Record<string, unknown> = {}): Promise<string> {
  const result = await call(admin.collection, { method: 'POST', body: createBody(overrides) });
  expect(result.status).toBe(201);
  return (result.body as { id: string }).id;
}

/** The row with its only tool reviewed and switched on, as an admin leaves it. */
async function createReviewedPlatform(overrides: Record<string, unknown> = {}): Promise<string> {
  const id = await createPlatform(overrides);
  const review = { tools: [{ name: 'search', enabled: true, versionHash: 'v1' }] };
  expect((await call(admin.item, { method: 'PATCH', id, body: review })).status).toBe(200);
  return id;
}

const listAs = async (as: unknown) =>
  (await call(user.collection, { method: 'GET', as })).body as Array<Record<string, unknown>>;

beforeAll(async () => {
  h.makeSlugError = slug => new McpConnectionSlugConflictError(slug);
  admin.collection = (await import('../index')).default as unknown as Handler;
  admin.item = (await import('../[id]/index')).default as unknown as Handler;
  admin.refresh = (await import('../[id]/refresh-tools')).default as unknown as Handler;
  admin.apiKey = (await import('../[id]/api-key')).default as unknown as Handler;
  user.collection = (await import('../../../mcp-connections/index')).default as unknown as Handler;
  user.item = (await import('../../../mcp-connections/[id]/index')).default as unknown as Handler;
  user.refresh = (await import('../../../mcp-connections/[id]/refresh-tools')).default as unknown as Handler;
  user.apiKey = (await import('../../../mcp-connections/[id]/api-key')).default as unknown as Handler;
  user.oauthStart = (await import('../../../mcp-connections/[id]/oauth/start')).default as unknown as Handler;
  user.oauthDisconnect = (await import('../../../mcp-connections/[id]/oauth/disconnect')).default as unknown as Handler;
});

beforeEach(() => {
  vi.clearAllMocks();
  installRepo();
  h.store.clear();
  h.adminAudits.length = 0;
  h.context = context();
  discover.mockImplementation(async (id: string) => {
    const doc = h.store.get(id)!;
    Object.assign(doc, {
      status: 'connected',
      tools: [
        {
          name: 'search',
          description: 'Searches the docs',
          descriptionRawHash: 'h',
          inputSchema: { type: 'object' },
          versionHash: 'v1',
          enabled: false,
          approval: 'default',
          state: 'pending_review',
          firstSeenAt: new Date(),
        },
      ],
    });
    return { connection: defaultRead(doc), added: ['search'], changed: [], removed: [], dropped: 0 };
  });
});

describe('admin route wiring', () => {
  it('every admin route is session-only, admin-scoped, and declares a permission per method', () => {
    const adminOptions = h.baseApiOptions.filter(options => options.requiredScopes);
    expect(adminOptions).toHaveLength(4);
    for (const options of adminOptions) {
      expect(options).toMatchObject({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] });
    }
    expect(adminOptions.map(options => options.allowedMethods)).toEqual([
      ['GET', 'POST'],
      ['GET', 'PATCH', 'DELETE'],
      ['POST'],
      ['POST'],
    ]);
  });

  it('limits each route that probes the remote server like its user route, in a bucket of its own', () => {
    const limits = new Map(h.rateLimits.map(options => [options.bucket, options.limit]));
    for (const [bucket, limit] of [
      ['POST /api/admin/mcp-connections', 10],
      ['POST /api/admin/mcp-connections/[id]/api-key', 10],
      ['POST /api/admin/mcp-connections/[id]/refresh-tools', 20],
    ] as const) {
      expect(limits.get(bucket)).toBe(limit);
      expect(limits.get(bucket.replace('/admin', ''))).toBe(limit);
    }
  });

  it('refuses a user who is not an admin on every route', async () => {
    const id = await createPlatform();
    for (const [handler, method] of [
      [admin.collection, 'GET'],
      [admin.collection, 'POST'],
      [admin.item, 'GET'],
      [admin.item, 'PATCH'],
      [admin.item, 'DELETE'],
      [admin.refresh, 'POST'],
      [admin.apiKey, 'POST'],
    ] as const) {
      const result = await call(handler, { method, as: USER, id, body: { enabled: false } });
      expect(result.status).toBe(403);
      expect(result.raw).not.toContain('mcp.example.com');
    }
    expect(h.store.get(id)).toMatchObject({ enabled: true });
  });

  it('lets a settings reader look but not write', async () => {
    const id = await createPlatform();
    expect((await call(admin.collection, { method: 'GET', as: READER })).status).toBe(200);
    expect((await call(admin.item, { method: 'GET', as: READER, id })).status).toBe(200);
    expect((await call(admin.collection, { method: 'POST', as: READER, body: createBody() })).status).toBe(403);
    expect((await call(admin.item, { method: 'PATCH', as: READER, id, body: { enabled: false } })).status).toBe(403);
    expect((await call(admin.item, { method: 'DELETE', as: READER, id })).status).toBe(403);
    expect((await call(admin.refresh, { method: 'POST', as: READER, id })).status).toBe(403);
    expect((await call(admin.apiKey, { method: 'POST', as: READER, id, body: { value: NEW_KEY } })).status).toBe(403);
  });
});

describe('POST /api/admin/mcp-connections', () => {
  it('stores a platform row under the catalog-only policy, probes it as the platform, and audits', async () => {
    const result = await call(admin.collection, { method: 'POST', body: createBody() });

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      ownerType: 'platform',
      slug: 'docs',
      urlHost: 'mcp.example.com',
      status: 'connected',
      auth: { kind: 'api_key', apiKey: { headerName: 'Authorization', scheme: 'Bearer', last4: '6789' } },
      tools: [{ name: 'search', state: 'pending_review', enabled: false }],
    });
    expect(result.raw).not.toContain(API_KEY);
    expect(result.raw).not.toContain('enc:');

    const stored = [...h.store.values()][0] as unknown as Doc;
    expect(stored).toMatchObject({ ...PLATFORM_MCP_OWNER, userId: 'admin-1' });
    expect(stored).not.toHaveProperty('organizationId');
    expect(repo.createWithinUserCap).not.toHaveBeenCalled();
    expect(discover).toHaveBeenCalledWith(stored.id, 'admin-1', expect.anything(), PLATFORM_MCP_OWNER);
    expect(h.adminAudits).toEqual([
      {
        action: 'settings.mcp_connector.created',
        target: { kind: 'settings', id: stored.id, displayName: 'Docs MCP connector' },
        summary: 'created platform MCP connector docs on mcp.example.com',
        details: { authKind: 'api_key', status: 'connected' },
      },
    ]);
    expect(JSON.stringify(h.adminAudits)).not.toMatch(/WXYZ|6789|SUPERSECRET/);
  });

  it.each([
    ['OAuth sign-in', { auth: { kind: 'oauth' } }],
    ['a catalog preset', { presetId: 'some-preset' }],
    ['an unknown field', { ownerType: 'user' }],
  ])('refuses %s with a 400 and writes nothing', async (_label, overrides) => {
    const result = await call(admin.collection, { method: 'POST', body: createBody(overrides) });
    expect(result.status).toBe(400);
    expect(h.store.size).toBe(0);
    expect(h.adminAudits).toEqual([]);
  });

  it('is still closed by the blocklist, an organization allowlist, and the switch', async () => {
    h.context = context({ platformBlockedHosts: ['mcp.example.com'] });
    expect((await call(admin.collection, { method: 'POST', body: createBody() })).status).toBe(403);
    h.context = context({
      policies: [CustomMcpPolicySchema.parse({ mode: 'allowlist', allowedHostPatterns: ['other.example.com'] })],
    });
    expect((await call(admin.collection, { method: 'POST', body: createBody() })).status).toBe(403);
    h.context = context({ enabled: false });
    expect((await call(admin.collection, { method: 'POST', body: createBody() })).status).toBe(403);
    expect(h.store.size).toBe(0);
    expect(h.adminAudits).toEqual([]);
  });

  it('answers 409 for a slug another platform connector holds, and is not capped per user', async () => {
    await createPlatform({ slug: 'docs' });
    const taken = await call(admin.collection, { method: 'POST', body: createBody({ slug: 'docs' }) });
    expect(taken).toMatchObject({ status: 409, body: { code: 'slug_taken' } });

    h.context = context({ maxConnectionsPerUser: 1 });
    await createPlatform();
    expect([...h.store.values()].map(doc => doc.slug)).toEqual(['docs', 'docs_2']);
  });
});

describe('the other admin routes', () => {
  it('GET lists and reads every platform row with the admin view, even with the switch off', async () => {
    const id = await createPlatform();
    h.context = context({ enabled: false });

    const listed = await call(admin.collection, { method: 'GET' });
    expect(listed.body).toMatchObject([{ id, auth: { apiKey: { last4: '6789' } }, displayUrl: expect.any(String) }]);
    expect((await call(admin.item, { method: 'GET', id })).body).toMatchObject({ id, slug: 'docs' });
    expect(listed.raw).not.toContain('enc:');
    expect((await call(admin.item, { method: 'GET', id: 'not-an-id' })).status).toBe(404);
  });

  it('PATCH reviews, renames and switches off, with the switch off too, and audits what changed', async () => {
    const id = await createReviewedPlatform();
    expect(h.store.get(id)).toMatchObject({ tools: [{ name: 'search', enabled: true, state: 'active' }] });

    h.context = context({ enabled: false });
    const result = await call(admin.item, { method: 'PATCH', id, body: { displayName: 'Handbook', enabled: false } });
    expect(result.body).toMatchObject({ displayName: 'Handbook', enabled: false });
    expect(h.adminAudits.slice(1)).toEqual([
      {
        action: 'settings.mcp_connector.updated',
        target: { kind: 'settings', id, displayName: 'Docs MCP connector' },
        summary: 'updated platform MCP connector docs on mcp.example.com',
        changes: [],
        details: { reviewedTools: 1 },
      },
      {
        action: 'settings.mcp_connector.updated',
        target: { kind: 'settings', id, displayName: 'Handbook MCP connector' },
        summary: 'updated platform MCP connector docs on mcp.example.com',
        changes: [
          { field: 'displayName', before: 'Docs', after: 'Handbook' },
          { field: 'enabled', before: true, after: false },
        ],
      },
    ]);
  });

  it('refresh and key rotation act on the platform row and are audited without the key', async () => {
    const id = await createPlatform();

    const refreshed = await call(admin.refresh, { method: 'POST', id });
    expect(refreshed).toMatchObject({ status: 200, body: { connection: { id }, discovery: { added: ['search'] } } });
    const rotated = await call(admin.apiKey, { method: 'POST', id, body: { value: NEW_KEY } });
    expect(rotated).toMatchObject({ status: 200, body: { auth: { apiKey: { last4: 'ijkl' } } } });
    expect(rotated.raw).not.toContain(NEW_KEY);

    const stored = h.store.get(id) as unknown as Doc;
    expect(stored.auth.apiKey?.valueEnc).toBe(`enc:${Buffer.from(NEW_KEY).toString('base64')}`);
    expect(discover.mock.calls.map(args => args[3])).toEqual(Array(3).fill(PLATFORM_MCP_OWNER));
    expect(h.adminAudits.slice(1)).toMatchObject([
      {
        action: 'settings.mcp_connector.tools_refreshed',
        summary: 'refreshed the tools of platform MCP connector docs on mcp.example.com',
        details: { added: 1, changed: 0, removed: 0, dropped: 0 },
      },
      {
        action: 'settings.mcp_connector.api_key_rotated',
        summary: 'rotated the key of platform MCP connector docs on mcp.example.com',
      },
    ]);
    expect(JSON.stringify(h.adminAudits)).not.toMatch(/ROTATED|ijkl/);

    h.context = context({ enabled: false });
    expect((await call(admin.refresh, { method: 'POST', id })).status).toBe(403);
    expect((await call(admin.apiKey, { method: 'POST', id, body: { value: NEW_KEY } })).status).toBe(403);
  });

  it('a failed refresh still answers 502 and is audited as failed with its error code', async () => {
    const id = await createPlatform();
    const { RemoteMcpError } = await import('@bike4mind/mcp/remote');
    discover.mockRejectedValueOnce(new RemoteMcpError('protocol', 'not an MCP server'));

    const refreshed = await call(admin.refresh, { method: 'POST', id });
    expect(refreshed.status).toBe(502);
    expect(h.adminAudits.slice(1)).toEqual([
      {
        action: 'settings.mcp_connector.tools_refreshed',
        target: { kind: 'settings', id, displayName: 'Docs MCP connector' },
        summary: 'failed to refresh the tools of platform MCP connector docs on mcp.example.com',
        details: { outcome: 'failed', errorCode: 'protocol' },
      },
    ]);

    expect((await call(admin.refresh, { method: 'POST', id: 'not-an-id' })).status).toBe(404);
    expect(h.adminAudits).toHaveLength(2);
  });

  it('DELETE removes the row and audits it; a second delete is a 404 with no audit entry', async () => {
    const id = await createPlatform();
    expect((await call(admin.item, { method: 'DELETE', id })).status).toBe(204);
    expect(h.store.size).toBe(0);
    expect(h.adminAudits.at(-1)).toMatchObject({
      action: 'settings.mcp_connector.deleted',
      summary: 'deleted platform MCP connector docs on mcp.example.com',
    });

    expect((await call(admin.item, { method: 'DELETE', id })).status).toBe(404);
    expect(h.adminAudits).toHaveLength(2);
  });

  it('cannot reach a user connection through an admin route', async () => {
    h.context = anyHost();
    const mine = await call(user.collection, { method: 'POST', as: USER, body: createBody() });
    const id = (mine.body as { id: string }).id;

    expect((await call(admin.item, { method: 'GET', id })).status).toBe(404);
    expect((await call(admin.item, { method: 'PATCH', id, body: { enabled: false } })).status).toBe(404);
    expect((await call(admin.item, { method: 'DELETE', id })).status).toBe(404);
    expect((await call(admin.apiKey, { method: 'POST', id, body: { value: NEW_KEY } })).status).toBe(404);
    expect((await call(admin.collection, { method: 'GET' })).body).toEqual([]);
    expect(h.store.get(id)).toMatchObject({ ownerType: 'user', enabled: true });
  });
});

describe('a platform connector description', () => {
  const NOTE = 'Searches the team handbook.';

  it('is set on create and changed by PATCH, with only its length in the admin audit', async () => {
    const created = await call(admin.collection, { method: 'POST', body: createBody({ description: ` ${NOTE} ` }) });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;
    expect(created.body).toMatchObject({ description: NOTE });
    expect((await call(admin.collection, { method: 'GET' })).body).toMatchObject([{ id, description: NOTE }]);

    const changed = await call(admin.item, { method: 'PATCH', id, body: { description: 'Reads the handbook.' } });
    expect(changed.body).toMatchObject({ description: 'Reads the handbook.' });
    expect(h.adminAudits.at(-1)).toEqual({
      action: 'settings.mcp_connector.updated',
      target: { kind: 'settings', id, displayName: 'Docs MCP connector' },
      summary: 'updated platform MCP connector docs on mcp.example.com',
      changes: [],
      details: { descriptionLength: 19 },
    });
    await call(admin.item, { method: 'PATCH', id, body: { description: '' } });
    expect(h.adminAudits.at(-1)).toMatchObject({ details: { descriptionLength: 0 } });
    expect(h.store.get(id)?.description).toBe('');
    expect(JSON.stringify(h.adminAudits)).not.toMatch(/handbook/);
  });

  it('cannot be set or changed by a user who is not an admin, or by a settings reader', async () => {
    const id = await createPlatform({ description: NOTE });
    const body = createBody({ slug: 'mine', description: 'Mine now' });
    expect((await call(admin.collection, { method: 'POST', as: USER, body })).status).toBe(403);
    const hijack = { description: 'Hijacked' };
    for (const as of [USER, READER]) {
      expect((await call(admin.item, { method: 'PATCH', id, as, body: hijack })).status).toBe(403);
    }
    expect((await call(user.item, { method: 'PATCH', id, as: USER, body: hijack })).status).toBe(404);
    expect(h.store.get(id)?.description).toBe(NOTE);
    expect(h.store.size).toBe(1);
  });

  it('reaches every user in the member list, and a connector without one carries none', async () => {
    const described = await createReviewedPlatform({ description: NOTE });
    const plain = await createReviewedPlatform({ displayName: 'Wiki' });

    for (const as of [USER, { id: 'user-2', organizationId: null }]) {
      const listed = await listAs(as);
      expect(listed.find(entry => entry.id === described)).toMatchObject({ ownerType: 'platform', description: NOTE });
      expect(listed.find(entry => entry.id === plain)).not.toHaveProperty('description');
    }
  });
});

describe('a platform connector seen from the user routes', () => {
  it('is listed for every user as the member view, field by field', async () => {
    const id = await createReviewedPlatform();

    for (const as of [USER, { id: 'user-2', organizationId: null }, ADMIN]) {
      expect(await listAs(as)).toEqual([
        {
          id,
          ownerType: 'platform',
          slug: 'docs',
          displayName: 'Docs',
          urlHost: 'mcp.example.com',
          status: 'connected',
          enabled: true,
          tools: [
            {
              name: 'search',
              description: 'Searches the docs',
              descriptionRawHash: 'h',
              versionHash: 'v1',
              enabled: true,
              approval: 'default',
              state: 'active',
              firstSeenAt: expect.any(String),
            },
          ],
        },
      ]);
    }
  });

  it('shows a member no creator, key detail, URL path, error or last use', async () => {
    const id = await createReviewedPlatform();
    Object.assign(h.store.get(id)!, {
      lastError: { code: 'timeout', message: 'The server did not answer', at: new Date() },
      lastUsedAt: new Date(),
    });

    const raw = (await call(user.collection, { method: 'GET', as: USER })).raw;
    for (const hidden of ['admin-1', '6789', 'WXYZ', 'Authorization', 'did not answer', 'enc:', API_KEY]) {
      expect(raw).not.toContain(hidden);
    }
    for (const field of ['userId', 'auth', 'last4', 'displayUrl', 'lastError', 'lastUsedAt', 'ownerKey']) {
      expect(raw).not.toContain(`"${field}"`);
    }
  });

  it("comes after the user's own connections and gives way to one with the same slug", async () => {
    await createReviewedPlatform();
    await createReviewedPlatform({ displayName: 'Wiki' });
    h.context = anyHost();
    await call(user.collection, { method: 'POST', as: USER, body: createBody({ displayName: 'Mine' }) });
    Object.assign(rowsOf({ ownerType: 'user', ownerKey: 'user-1' })[0]!, { slug: 'wiki', enabled: false });

    expect((await listAs(USER)).map(entry => [entry.slug, entry.ownerType])).toEqual([
      ['wiki', 'user'],
      ['docs', 'platform'],
    ]);
    expect((await listAs({ id: 'user-2' })).map(entry => entry.slug)).toEqual(['docs', 'wiki']);
  });

  it('is hidden once an admin switches it off, and for an organization that switched connectors off', async () => {
    const id = await createReviewedPlatform();
    h.context = context({ enabled: false, policies: [CustomMcpPolicySchema.parse({ mode: 'off' })] });
    expect(await listAs(USER)).toEqual([]);

    h.context = context();
    expect(await listAs(USER)).toHaveLength(1);
    await call(admin.item, { method: 'PATCH', id, body: { enabled: false } });
    expect(await listAs(USER)).toEqual([]);
  });

  it('reads blocked_by_policy for a member whose organization blocks the host', async () => {
    await createReviewedPlatform();
    h.context = context({
      policies: [CustomMcpPolicySchema.parse({ mode: 'any', blockedHostPatterns: ['mcp.example.com'] })],
    });
    expect((await listAs(USER)).map(entry => entry.status)).toEqual(['blocked_by_policy']);
  });

  it('answers every user route as for an unknown id, for a member and for the admin who made it', async () => {
    const id = await createReviewedPlatform();
    const before = structuredClone(h.store.get(id));
    h.context = anyHost();

    for (const as of [USER, ADMIN]) {
      for (const [handler, method, body] of [
        [user.item, 'GET', undefined],
        [user.item, 'PATCH', { enabled: false }],
        [user.item, 'PATCH', { displayName: 'Taken over' }],
        [user.item, 'PATCH', { tools: [{ name: 'search', enabled: false, versionHash: 'v1' }] }],
        [user.item, 'DELETE', undefined],
        [user.refresh, 'POST', undefined],
        [user.apiKey, 'POST', { value: NEW_KEY }],
        [user.oauthStart, 'POST', {}],
        [user.oauthDisconnect, 'POST', undefined],
      ] as const) {
        const result = await call(handler, { method, as, id, body });
        expect(result).toMatchObject({ status: 404, body: { error: 'Connection not found' } });
        for (const leaked of ['6789', 'mcp.example.com', 'docs', 'enc:']) expect(result.raw).not.toContain(leaked);
      }
    }
    expect(h.store.get(id)).toEqual(before);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(h.adminAudits).toHaveLength(2);
  });

  it('never gives a user connection a slug a platform connector holds', async () => {
    await createPlatform();
    h.context = anyHost();

    const derived = await call(user.collection, { method: 'POST', as: USER, body: createBody() });
    expect(derived).toMatchObject({ status: 201, body: { slug: 'docs_2', ownerType: 'user' } });
    const explicit = await call(user.collection, { method: 'POST', as: USER, body: createBody({ slug: 'docs' }) });
    expect(explicit).toMatchObject({ status: 409, body: { code: 'slug_taken' } });
    expect(rowsOf({ ownerType: 'user', ownerKey: 'user-1' }).map(doc => doc.slug)).toEqual(['docs_2']);
  });
});
