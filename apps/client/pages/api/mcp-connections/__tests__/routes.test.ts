// @vitest-environment node
import { EventEmitter } from 'events';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks, type RequestMethod } from 'node-mocks-http';
import {
  CustomMcpPolicySchema,
  McpConnectionCapError,
  McpConnectionSlugConflictError,
  McpToolVersionConflictError,
  type IMcpConnectionDocument,
  type McpApiKeyUpdate,
  type McpConnectionSettingsUpdate,
} from '@bike4mind/common';
import { RemoteMcpTimeoutError } from '@bike4mind/mcp/remote';
import type { CustomMcpContext } from '@server/mcpConnections/customMcpAccess';

/**
 * The four custom MCP connection routes, driven through a real next-connect router and the real
 * error handler, with the repository replaced by an in-memory owner-scoped store and the network
 * (probe and discovery) stubbed. The database-level races (connection cap, tools revision) are
 * exercised against a real mongod in McpConnectionModel.test.ts.
 */

type Doc = IMcpConnectionDocument;
type Handler = (req: unknown, res: unknown) => Promise<void>;

const h = vi.hoisted(() => ({
  baseApiOptions: [] as unknown[],
  rateLimitOptions: [] as Array<{ limit: number; windowMs: number; bucket?: string }>,
  perUserBuckets: [] as string[],
  counters: new Map<string, number>(),
  store: new Map<string, Record<string, unknown>>(),
  nextId: 0,
  context: undefined as unknown,
  audits: [] as Array<{ action: string; outcome: string }>,
  makeCapError: undefined as unknown as (cap: number) => Error,
  makeSlugError: undefined as unknown as (slug: string) => Error,
  makeTooMany: undefined as unknown as () => Error,
  makeVersionConflict: undefined as unknown as () => Error,
}));

vi.mock('@server/middlewares/baseApi', async () => {
  const nc = (await import('next-connect')).default;
  const errorHandler = (
    await vi.importActual<typeof import('@server/middlewares/errorHandler')>('@server/middlewares/errorHandler')
  ).default;
  return {
    baseApi: (options?: unknown) => {
      h.baseApiOptions.push(options);
      return nc({ onError: errorHandler });
    },
  };
});

vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: (options: { limit: number; windowMs: number; bucket?: string }) => {
    h.rateLimitOptions.push(options);
    return (req: { user: { id: string } }, _res: unknown, next: (error?: unknown) => void) => {
      const key = `${req.user.id}:${options.bucket}`;
      const count = (h.counters.get(key) ?? 0) + 1;
      h.counters.set(key, count);
      next(count > options.limit ? h.makeTooMany() : undefined);
    };
  },
}));

vi.mock('@server/middlewares/perUserRateLimit', () => ({
  perUserRateLimit: (bucket: string) => {
    h.perUserBuckets.push(bucket);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));

vi.mock('@server/mcpConnections/customMcpAccess', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/mcpConnections/customMcpAccess')>();
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
vi.mock('@server/middlewares/featureFlag', () => ({ isFeatureEnabled: vi.fn(async () => true) }));
vi.mock('@bike4mind/services', () => ({ scopedSettingsService: {} }));
vi.mock('sst', () => ({ Resource: {} }));
vi.mock('@server/utils/cloudwatch', () => ({
  recordCircuitBreakerRejection: vi.fn(async () => undefined),
  recordCircuitBreakerTransition: vi.fn(async () => undefined),
}));
vi.mock('@server/security/tokenEncryption', () => ({
  encryptToken: (value: string | null | undefined) => (value ? `enc:${Buffer.from(value).toString('base64')}` : null),
  decryptToken: (value: string | null | undefined) => value,
}));
vi.mock('@server/integrations/integrationAuditLogger', () => ({
  IntegrationAuditLogger: {
    create: (context: { action: string }) => ({
      success: () => h.audits.push({ action: context.action, outcome: 'success' }),
      failure: (code: string) => h.audits.push({ action: context.action, outcome: `failure:${code}` }),
      rateLimited: () => h.audits.push({ action: context.action, outcome: 'rate_limited' }),
    }),
  },
}));

const discover = vi.hoisted(() => vi.fn());
vi.mock('@server/mcpConnections/discovery', () => ({ discoverConnectionTools: discover }));

/** Default reads deselect the secrets, as the real repository does. */
function defaultRead(doc: Record<string, unknown> | undefined): Doc | null {
  if (!doc) return null;
  const copy = structuredClone(doc) as unknown as Doc;
  delete copy.urlEnc;
  if (copy.auth.apiKey) delete copy.auth.apiKey.valueEnc;
  return copy;
}

const ownerMatches = (doc: Record<string, unknown> | undefined, owner: { ownerKey: string }) =>
  doc && doc.ownerType === 'user' && doc.ownerKey === owner.ownerKey;

const repo = vi.hoisted(() => ({
  createWithinUserCap: vi.fn(),
  findByIdForOwner: vi.fn(),
  listAllForUser: vi.fn(),
  updateSettings: vi.fn(),
  setStatus: vi.fn(),
  setApiKey: vi.fn(),
  deleteForOwner: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({ mcpConnectionRepository: repo, cacheRepository: {} }));

function installRepo(): void {
  repo.createWithinUserCap.mockImplementation(async (data: Record<string, unknown>, cap: number) => {
    const mine = [...h.store.values()].filter(doc => doc.userId === data.userId);
    if (mine.length >= cap) throw h.makeCapError(cap);
    if (mine.some(doc => doc.slug === data.slug)) throw h.makeSlugError(String(data.slug));
    h.nextId += 1;
    const id = h.nextId.toString(16).padStart(24, '0');
    const now = new Date();
    h.store.set(id, { ...structuredClone(data), id, createdAt: now, updatedAt: now });
    return defaultRead(h.store.get(id));
  });
  repo.findByIdForOwner.mockImplementation(async (id: string, owner: { ownerKey: string }) =>
    ownerMatches(h.store.get(id), owner) ? defaultRead(h.store.get(id)) : null
  );
  repo.listAllForUser.mockImplementation(async (userId: string) =>
    [...h.store.values()].filter(doc => doc.userId === userId).map(doc => defaultRead(doc))
  );
  const patch = (id: string, owner: { ownerKey: string }, set: Record<string, unknown>) => {
    const doc = h.store.get(id);
    if (!ownerMatches(doc, owner)) return null;
    Object.assign(doc!, set);
    return defaultRead(doc);
  };
  // One write, refused whole when a reviewed version is stale, as the real repository does.
  repo.updateSettings.mockImplementation(
    async (id: string, owner: { ownerKey: string }, { tools: settings, ...rest }: McpConnectionSettingsUpdate) => {
      const doc = h.store.get(id);
      if (!ownerMatches(doc, owner)) return null;
      const stored = doc!.tools as Doc['tools'];
      const stale = (settings ?? []).some(
        entry =>
          entry.versionHash !== undefined &&
          !stored.some(t => t.name === entry.name && t.versionHash === entry.versionHash)
      );
      if (stale) throw h.makeVersionConflict();
      const tools = stored.map(tool => {
        const entry = settings?.find(s => s.name === tool.name);
        if (!entry) return tool;
        const { versionHash: _reviewed, ...choices } = entry;
        return { ...tool, ...choices };
      });
      return patch(id, owner, { ...rest, tools });
    }
  );
  repo.setApiKey.mockImplementation(async (id: string, owner: { ownerKey: string }, apiKey: McpApiKeyUpdate) => {
    const doc = h.store.get(id);
    if (!ownerMatches(doc, owner) || (doc!.auth as Doc['auth']).kind !== 'api_key') return null;
    return patch(id, owner, { auth: { kind: 'api_key', apiKey } });
  });
  repo.setStatus.mockImplementation(async (id: string, status: string, lastError?: Record<string, unknown>) => {
    const doc = h.store.get(id);
    if (!doc) return null;
    Object.assign(doc, { status, lastError });
    return defaultRead(doc);
  });
  repo.deleteForOwner.mockImplementation(async (id: string, owner: { ownerKey: string }) => {
    if (!ownerMatches(h.store.get(id), owner)) return false;
    return h.store.delete(id);
  });
}

const USER = { id: 'user-1', organizationId: null };
const OTHER = { id: 'user-2', organizationId: null };
const API_KEY = 'lin_api_SUPERSECRET_0123456789';
const quietLogger = { warn: () => undefined, error: () => undefined, info: () => undefined, debug: () => undefined };

const context = (overrides: Partial<CustomMcpContext> = {}): CustomMcpContext => ({
  enabled: true,
  policies: [CustomMcpPolicySchema.parse({ mode: 'any' })],
  platformBlockedHosts: [],
  organizationIds: [],
  network: { ownHosts: ['app.example.com'] },
  maxConnectionsPerUser: 20,
  ...overrides,
});

const routes = {} as Record<'collection' | 'item' | 'refresh' | 'apiKey', Handler>;

async function call(
  handler: Handler,
  { method, user = USER, id, body }: { method: RequestMethod; user?: unknown; id?: string; body?: unknown }
): Promise<{ status: number; body: unknown; raw: string }> {
  // next-connect resolves once the response emits `finish`, which needs a real emitter.
  const { req, res } = createMocks(
    {
      method,
      url: id ? `/api/mcp-connections/${id}` : '/api/mcp-connections',
      query: id ? { id } : {},
      body: body as Record<string, unknown>,
    },
    { eventEmitter: EventEmitter }
  );
  Object.assign(req, { user, logger: quietLogger, requestId: 'req-1' });
  await handler(req, res);
  const raw = String(res._getData() ?? '');
  return { status: res._getStatusCode(), body: res._isJSON() ? res._getJSONData() : raw, raw };
}

const createBody = (overrides: Record<string, unknown> = {}) => ({
  url: 'https://mcp.linear.app/mcp',
  displayName: 'Linear',
  auth: { kind: 'api_key', value: API_KEY },
  ...overrides,
});

async function createConnection(overrides: Record<string, unknown> = {}, user: unknown = USER) {
  const result = await call(routes.collection, { method: 'POST', body: createBody(overrides), user });
  return result;
}

beforeAll(async () => {
  h.makeCapError = cap => new McpConnectionCapError(cap);
  h.makeSlugError = slug => new McpConnectionSlugConflictError(slug);
  h.makeVersionConflict = () => new McpToolVersionConflictError();
  const { TooManyRequestsError } = await import('@bike4mind/common');
  h.makeTooMany = () => new TooManyRequestsError('Rate limit exceeded');
  routes.collection = (await import('../index')).default as unknown as Handler;
  routes.item = (await import('../[id]/index')).default as unknown as Handler;
  routes.refresh = (await import('../[id]/refresh-tools')).default as unknown as Handler;
  routes.apiKey = (await import('../[id]/api-key')).default as unknown as Handler;
});

beforeEach(() => {
  vi.clearAllMocks();
  installRepo();
  h.store.clear();
  h.counters.clear();
  h.audits.length = 0;
  h.context = context();
  discover.mockImplementation(async (id: string) => {
    const doc = h.store.get(id)!;
    Object.assign(doc, {
      status: 'connected',
      tools: [
        {
          name: 'list_issues',
          description: 'Lists issues',
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
    return { connection: defaultRead(doc), added: ['list_issues'], changed: [], removed: [], dropped: 0 };
  });
});

describe('route wiring', () => {
  it('every route is session-only, never reachable with an API key', () => {
    expect(h.baseApiOptions).toHaveLength(4);
    for (const options of h.baseApiOptions) expect(options).toEqual({ auth: 'jwtOnly' });
  });

  it('applies the design rate limits with stable buckets', () => {
    expect(h.rateLimitOptions).toEqual(
      expect.arrayContaining([
        { limit: 10, windowMs: 3_600_000, bucket: 'POST /api/mcp-connections' },
        { limit: 20, windowMs: 3_600_000, bucket: 'POST /api/mcp-connections/[id]/refresh-tools' },
        { limit: 10, windowMs: 3_600_000, bucket: 'POST /api/mcp-connections/[id]/api-key' },
      ])
    );
    expect(h.perUserBuckets).toEqual(
      expect.arrayContaining([
        'GET /api/mcp-connections',
        'GET /api/mcp-connections/[id]',
        'PATCH /api/mcp-connections/[id]',
        'DELETE /api/mcp-connections/[id]',
      ])
    );
  });
});

describe('POST /api/mcp-connections', () => {
  it('creates, probes and returns only the public view: the API key and URL ciphertext never come back', async () => {
    const result = await createConnection();

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      slug: 'linear',
      displayName: 'Linear',
      displayUrl: 'https://mcp.linear.app/mcp',
      urlHost: 'mcp.linear.app',
      status: 'connected',
      auth: { kind: 'api_key', apiKey: { headerName: 'Authorization', scheme: 'Bearer', last4: '6789' } },
      tools: [{ name: 'list_issues', state: 'pending_review', enabled: false }],
    });
    expect(result.raw).not.toContain(API_KEY);
    expect(result.raw).not.toContain('enc:');
    expect(result.body).not.toHaveProperty('urlEnc');

    const stored = [...h.store.values()][0] as unknown as Doc;
    expect(stored.auth.apiKey?.valueEnc).toBe(`enc:${Buffer.from(API_KEY).toString('base64')}`);
    expect(stored.urlEnc).toMatch(/^enc:/);
    expect(stored).toMatchObject({ ownerType: 'user', ownerKey: 'user-1', userId: 'user-1' });
    expect(discover).toHaveBeenCalledWith(stored.id, 'user-1', expect.objectContaining({ context: h.context }));
    expect(h.audits.map(a => `${a.action}:${a.outcome}`)).toEqual([
      'connection_created:success',
      'probe_result:success',
    ]);
  });

  it('keeps the connection with its recorded status when the probe fails', async () => {
    discover.mockImplementation(async (id: string) => {
      Object.assign(h.store.get(id)!, {
        status: 'error',
        lastError: { code: 'timeout', message: 'slow', at: new Date() },
      });
      throw new RemoteMcpTimeoutError('slow');
    });
    const result = await createConnection({ auth: { kind: 'none' } });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ status: 'error', lastError: { code: 'timeout' }, auth: { kind: 'none' } });
    expect(h.audits).toContainEqual({ action: 'probe_result', outcome: 'failure:timeout' });
  });

  it('never fails a create after the write: an operational probe failure is recorded with its real code', async () => {
    const { ConflictError } = await import('@bike4mind/common');
    discover.mockRejectedValueOnce(new ConflictError('raced', { code: 'discovery_conflict' }));
    const result = await createConnection();
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ status: 'error', lastError: { code: 'discovery_failed' } });
    expect(h.audits).toContainEqual({ action: 'probe_result', outcome: 'failure:discovery_conflict' });

    const validation = Object.assign(new Error('tools: too long'), { name: 'ValidationError' });
    discover.mockRejectedValueOnce(validation);
    const stored = await createConnection({ url: 'https://mcp2.linear.app/mcp' });
    expect(stored.status).toBe(201);
    expect(h.audits).toContainEqual({ action: 'probe_result', outcome: 'failure:validation_failed' });

    h.audits.length = 0;
    discover.mockRejectedValueOnce(h.makeTooMany());
    expect((await createConnection({ url: 'https://mcp3.linear.app/mcp' })).body).toMatchObject({
      lastError: { code: 'rate_limited' },
    });
    expect(h.audits).toContainEqual({ action: 'probe_result', outcome: 'failure:rate_limited' });
  });

  it('still surfaces a programmer error from the probe', async () => {
    discover.mockRejectedValueOnce(new TypeError('undefined is not a function'));
    expect((await createConnection()).status).toBe(500);
    expect(h.audits).toContainEqual({ action: 'probe_result', outcome: 'failure:internal_error' });
  });

  it('audits a create refused by policy or by the cap', async () => {
    h.context = context({ platformBlockedHosts: ['*.linear.app'] });
    expect((await createConnection()).status).toBe(403);
    expect(h.audits).toContainEqual({ action: 'connection_created', outcome: 'failure:policy_blocked' });

    h.context = context({ maxConnectionsPerUser: 0 });
    expect((await createConnection()).status).toBe(409);
    expect(h.audits).toContainEqual({ action: 'connection_created', outcome: 'failure:connection_limit' });
  });

  it('answers 403 with the switch off and writes nothing', async () => {
    h.context = context({ enabled: false });
    const result = await createConnection();
    expect(result.status).toBe(403);
    expect(repo.createWithinUserCap).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
  });

  it('refuses a custom URL under the default presets_only policy and a blocked host, before writing', async () => {
    h.context = context({ policies: [CustomMcpPolicySchema.parse({})] });
    const presetsOnly = await createConnection();
    expect(presetsOnly.status).toBe(403);
    expect(presetsOnly.body).toMatchObject({ code: 'policy_blocked', reason: 'presets_only' });

    h.context = context({ platformBlockedHosts: ['*.linear.app'] });
    expect((await createConnection()).body).toMatchObject({ reason: 'platform_blocked_host' });

    h.context = context({ policies: [CustomMcpPolicySchema.parse({ mode: 'any', allowUnauthenticated: false })] });
    expect((await createConnection({ auth: { kind: 'none' } })).body).toMatchObject({
      reason: 'unauthenticated_not_allowed',
    });
    expect(repo.createWithinUserCap).not.toHaveBeenCalled();
  });

  it('refuses the deployment own host and internal addresses with a 400 reason', async () => {
    const own = await createConnection({ url: 'https://app.example.com/mcp' });
    expect(own.status).toBe(400);
    expect(own.body).toMatchObject({ code: 'invalid_url', reason: 'own_host' });
    expect((await createConnection({ url: 'http://mcp.linear.app/mcp' })).body).toMatchObject({ reason: 'scheme' });
    expect((await createConnection({ url: 'https://169.254.169.254/' })).body).toMatchObject({ reason: 'ip_literal' });
  });

  it('refuses an API key over self-host plain http to a hostname, before writing', async () => {
    h.context = context({ network: { ownHosts: [], allowHttp: true, allowPrivateCidrs: ['10.20.0.0/16'] } });
    const result = await createConnection({ url: 'http://mcp.internal.example:8080/mcp' });
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ code: 'policy_blocked', reason: 'api_key_over_http' });
    expect(repo.createWithinUserCap).not.toHaveBeenCalled();
  });

  it.each(['Host', 'Cookie', 'X-Forwarded-For', 'Mcp-Session-Id', 'Transfer-Encoding', 'bad header'])(
    'refuses the API-key header %j without echoing the key',
    async headerName => {
      const result = await createConnection({ auth: { kind: 'api_key', headerName, value: API_KEY } });
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({
        code: 'invalid_body',
        issues: [expect.objectContaining({ path: 'auth.headerName' })],
      });
      expect(result.raw).not.toContain(API_KEY);
    }
  );

  it('refuses unknown or server-owned fields and a key with a header-splitting value', async () => {
    expect((await createConnection({ ownerKey: 'user-2' })).status).toBe(400);
    expect((await createConnection({ status: 'connected' })).status).toBe(400);
    const splitting = await createConnection({ auth: { kind: 'api_key', value: 'abc\r\nX-Evil: 1' } });
    expect(splitting.status).toBe(400);
    expect(splitting.raw).not.toContain('X-Evil');
  });

  it('answers a typed 409 for an explicit slug already taken, and suffixes a derived one', async () => {
    expect((await createConnection({ slug: 'work_linear' })).status).toBe(201);
    const conflict = await createConnection({ slug: 'work_linear', url: 'https://mcp2.linear.app/mcp' });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: 'slug_taken', slug: 'work_linear' });

    expect((await createConnection()).body).toMatchObject({ slug: 'linear' });
    expect((await createConnection()).body).toMatchObject({ slug: 'linear_2' });
  });

  it('refuses a reserved or malformed explicit slug', async () => {
    expect((await createConnection({ slug: 'github' })).status).toBe(400);
    expect((await createConnection({ slug: 'bad__slug' })).status).toBe(400);
  });

  it('enforces the per-user cap from the strictest policy with a typed 409', async () => {
    h.context = context({ maxConnectionsPerUser: 1 });
    expect((await createConnection()).status).toBe(201);
    const capped = await createConnection({ url: 'https://mcp.airtable.com/mcp', displayName: 'Airtable' });
    expect(capped.status).toBe(409);
    expect(capped.body).toMatchObject({ code: 'connection_limit', limit: 1 });
    expect(repo.createWithinUserCap).toHaveBeenLastCalledWith(expect.anything(), 1);
    // Another user is counted separately.
    expect((await createConnection({}, OTHER)).status).toBe(201);
  });

  it('holds creates to 10 an hour per user', async () => {
    h.context = context({ enabled: false });
    for (let i = 0; i < 10; i++) expect((await createConnection()).status).toBe(403);
    expect((await createConnection()).status).toBe(429);
    expect((await createConnection({}, OTHER)).status).toBe(403);
  });
});

describe('GET /api/mcp-connections', () => {
  it('lists only the caller connections, as public views with the current policy verdict', async () => {
    await createConnection();
    await createConnection({ url: 'https://mcp.blocked.example/mcp', displayName: 'Blocked' });
    await createConnection({}, OTHER);

    h.context = context({ platformBlockedHosts: ['mcp.blocked.example'] });
    const result = await call(routes.collection, { method: 'GET' });
    expect(result.status).toBe(200);
    expect((result.body as Array<{ slug: string; status: string }>).map(c => [c.slug, c.status])).toEqual([
      ['linear', 'connected'],
      ['blocked', 'blocked_by_policy'],
    ]);
    expect(result.raw).not.toContain(API_KEY);
    expect(result.raw).not.toContain('enc:');
  });

  it('shows nothing with the switch off', async () => {
    await createConnection();
    h.context = context({ enabled: false });
    const result = await call(routes.collection, { method: 'GET' });
    expect(result.body).toEqual([]);
    expect(repo.listAllForUser).not.toHaveBeenCalled();
  });
});

describe('/api/mcp-connections/[id]', () => {
  it('GET returns the owner view and 404s for anyone else or a junk id', async () => {
    const { body } = await createConnection();
    const id = (body as { id: string }).id;
    expect((await call(routes.item, { method: 'GET', id })).body).toMatchObject({ id, slug: 'linear' });
    expect((await call(routes.item, { method: 'GET', id, user: OTHER })).status).toBe(404);
    expect((await call(routes.item, { method: 'GET', id: 'not-an-id' })).status).toBe(404);
  });

  it('GET and PATCH answer 403 with the switch off; DELETE stays open', async () => {
    const id = ((await createConnection()).body as { id: string }).id;
    h.context = context({ enabled: false });
    expect((await call(routes.item, { method: 'GET', id })).status).toBe(403);
    expect((await call(routes.item, { method: 'PATCH', id, body: { enabled: false } })).status).toBe(403);
    expect((await call(routes.item, { method: 'DELETE', id })).status).toBe(204);
    expect(h.store.size).toBe(0);
  });

  it('PATCH renames, disables and saves a tool review; enabling a pending tool marks it reviewed', async () => {
    const id = ((await createConnection()).body as { id: string }).id;
    const result = await call(routes.item, {
      method: 'PATCH',
      id,
      body: {
        displayName: 'Linear (work)',
        enabled: false,
        tools: [{ name: 'list_issues', versionHash: 'v1', enabled: true }],
      },
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      displayName: 'Linear (work)',
      enabled: false,
      tools: [{ name: 'list_issues', enabled: true, state: 'active' }],
    });
    expect(repo.updateSettings).toHaveBeenCalledTimes(1);
    expect(repo.updateSettings).toHaveBeenCalledWith(
      id,
      { ownerType: 'user', ownerKey: 'user-1' },
      {
        displayName: 'Linear (work)',
        enabled: false,
        tools: [{ name: 'list_issues', versionHash: 'v1', enabled: true, state: 'active' }],
      }
    );
    expect(h.audits).toContainEqual({ action: 'tool_review_saved', outcome: 'success' });
    expect(h.audits).toContainEqual({ action: 'connection_disabled', outcome: 'success' });
    await call(routes.item, { method: 'PATCH', id, body: { enabled: true } });
    expect(h.audits).toContainEqual({ action: 'connection_enabled', outcome: 'success' });
  });

  it('PATCH binds a review to the version reviewed: missing is 400, unknown tool is 400, stale is 409', async () => {
    const id = ((await createConnection()).body as { id: string }).id;
    const patchTools = (tools: unknown[], extra: Record<string, unknown> = {}) =>
      call(routes.item, { method: 'PATCH', id, body: { ...extra, tools } });

    expect((await patchTools([{ name: 'list_issues', enabled: true }])).status).toBe(400);

    const unknown = await patchTools([{ name: 'not_a_tool', versionHash: 'v1', enabled: true }], {
      displayName: 'Renamed',
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ code: 'unknown_tool' });

    const stale = await patchTools([{ name: 'list_issues', versionHash: 'v0', enabled: true }], {
      displayName: 'Renamed',
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'tool_version_conflict' });

    expect(h.store.get(id)).toMatchObject({ displayName: 'Linear', tools: [{ enabled: false }] });
    expect(h.audits).not.toContainEqual({ action: 'tool_review_saved', outcome: 'success' });
  });

  it('PATCH refuses an empty or unknown-field body and another owner', async () => {
    const id = ((await createConnection()).body as { id: string }).id;
    expect((await call(routes.item, { method: 'PATCH', id, body: {} })).status).toBe(400);
    expect((await call(routes.item, { method: 'PATCH', id, body: { urlHost: 'evil.com' } })).status).toBe(400);
    expect((await call(routes.item, { method: 'PATCH', id, body: { enabled: false }, user: OTHER })).status).toBe(404);
    expect(h.store.get(id)?.enabled).toBe(true);
  });

  it('DELETE is owner-scoped and audited', async () => {
    const id = ((await createConnection()).body as { id: string }).id;
    expect((await call(routes.item, { method: 'DELETE', id, user: OTHER })).status).toBe(404);
    expect(h.store.has(id)).toBe(true);
    expect((await call(routes.item, { method: 'DELETE', id })).status).toBe(204);
    expect(h.store.has(id)).toBe(false);
    expect(h.audits).toContainEqual({ action: 'disconnected', outcome: 'success' });
  });
});

describe('POST /api/mcp-connections/[id]/refresh-tools', () => {
  it('returns the refreshed view and what changed', async () => {
    const id = ((await createConnection()).body as { id: string }).id;
    const result = await call(routes.refresh, { method: 'POST', id });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      connection: { id, status: 'connected' },
      discovery: { added: ['list_issues'], changed: [], removed: [], dropped: 0 },
    });
  });

  it('maps a remote failure to a 502 with its code, and 404s for another owner', async () => {
    const id = ((await createConnection()).body as { id: string }).id;
    discover.mockRejectedValueOnce(new RemoteMcpTimeoutError('slow'));
    const failed = await call(routes.refresh, { method: 'POST', id });
    expect(failed.status).toBe(502);
    expect(failed.body).toMatchObject({ code: 'timeout', error: 'The server did not answer in time' });
    expect((await call(routes.refresh, { method: 'POST', id, user: OTHER })).status).toBe(404);
  });

  it('re-checks the policy before refreshing', async () => {
    const id = ((await createConnection()).body as { id: string }).id;
    discover.mockClear();
    h.context = context({ platformBlockedHosts: ['mcp.linear.app'] });
    const blocked = await call(routes.refresh, { method: 'POST', id });
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ code: 'policy_blocked', reason: 'platform_blocked_host' });
    expect(discover).not.toHaveBeenCalled();
  });

  it('answers 403 with the switch off and holds refreshes to 20 an hour', async () => {
    const id = ((await createConnection()).body as { id: string }).id;
    h.context = context({ enabled: false });
    for (let i = 0; i < 20; i++) expect((await call(routes.refresh, { method: 'POST', id })).status).toBe(403);
    expect((await call(routes.refresh, { method: 'POST', id })).status).toBe(429);
  });
});

describe('POST /api/mcp-connections/[id]/api-key', () => {
  const NEW_KEY = 'lin_api_ROTATED_9876543210zz';

  it('rotates the key write-only, keeps the header unless replaced, and re-probes', async () => {
    const id = ((await createConnection()).body as { id: string }).id;
    discover.mockClear();
    const result = await call(routes.apiKey, { method: 'POST', id, body: { value: NEW_KEY } });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      auth: { apiKey: { headerName: 'Authorization', scheme: 'Bearer', last4: '10zz' } },
    });
    expect(result.raw).not.toContain(NEW_KEY);
    expect(repo.setApiKey).toHaveBeenCalledWith(
      id,
      { ownerType: 'user', ownerKey: 'user-1' },
      {
        headerName: 'Authorization',
        scheme: 'Bearer',
        valueEnc: `enc:${Buffer.from(NEW_KEY).toString('base64')}`,
        last4: '10zz',
      }
    );
    expect(discover).toHaveBeenCalledTimes(1);
    expect(h.audits).toContainEqual({ action: 'api_key_rotated', outcome: 'success' });
  });

  it('refuses a denied header, a connection without an API key, and another owner', async () => {
    const id = ((await createConnection()).body as { id: string }).id;
    const denied = await call(routes.apiKey, { method: 'POST', id, body: { value: NEW_KEY, headerName: 'Cookie' } });
    expect(denied.status).toBe(400);
    expect(denied.raw).not.toContain(NEW_KEY);

    const noAuth = (
      (await createConnection({ auth: { kind: 'none' }, url: 'https://open.example.com/mcp' })).body as {
        id: string;
      }
    ).id;
    const wrongKind = await call(routes.apiKey, { method: 'POST', id: noAuth, body: { value: NEW_KEY } });
    expect(wrongKind.status).toBe(409);
    expect(wrongKind.body).toMatchObject({ code: 'not_api_key' });

    expect((await call(routes.apiKey, { method: 'POST', id, body: { value: NEW_KEY }, user: OTHER })).status).toBe(404);
  });

  it('re-checks the policy before storing the new key', async () => {
    const id = ((await createConnection()).body as { id: string }).id;
    discover.mockClear();
    h.context = context({ platformBlockedHosts: ['mcp.linear.app'] });
    const blocked = await call(routes.apiKey, { method: 'POST', id, body: { value: NEW_KEY } });
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ code: 'policy_blocked', reason: 'platform_blocked_host' });
    expect(repo.setApiKey).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    expect(h.audits).toContainEqual({ action: 'api_key_rotated', outcome: 'failure:policy_blocked' });
  });

  it('answers 403 with the switch off', async () => {
    const id = ((await createConnection()).body as { id: string }).id;
    h.context = context({ enabled: false });
    expect((await call(routes.apiKey, { method: 'POST', id, body: { value: NEW_KEY } })).status).toBe(403);
    expect(repo.setApiKey).not.toHaveBeenCalled();
  });
});
