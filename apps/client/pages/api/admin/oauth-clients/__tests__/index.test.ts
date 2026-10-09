import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

const { handlers, configs, db, logAuditEvent } = vi.hoisted(() => ({
  configs: [] as unknown[],
  handlers: {} as Record<string, (req: unknown, res: unknown) => unknown>,
  db: { listOAuthClients: vi.fn(), createOAuthClient: vi.fn() },
  logAuditEvent: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    configs.push(config);
    const chain: Record<string, (fn: (req: unknown, res: unknown) => unknown) => unknown> = {};
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      chain[method] = (fn: (req: unknown, res: unknown) => unknown) => {
        handlers[method] = fn;
        return chain;
      };
    }
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => db);
vi.mock('@server/utils/auditLog', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/utils/auditLog')>()),
  logAuditEvent,
}));

import '@pages/api/admin/oauth-clients/index';

const view = {
  id: 'c1',
  clientId: 'b4m_my_app_0011aabb',
  name: 'My App',
  clientType: 'relying-party',
  tokenEndpointAuthMethod: 'client_secret_post',
  redirectUris: ['https://app.example.test/cb'],
  allowedScopes: ['openid', 'email', 'profile'],
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const SECRET = 'plaintext-secret-value-that-must-not-leak';

function makeReqRes(method: string, over: { user?: unknown; body?: unknown } = {}) {
  const { req, res } = createMocks({ method });
  (req as { user?: unknown }).user = 'user' in over ? over.user : { isAdmin: true, id: 'admin-1', username: 'root' };
  (req as { body?: unknown }).body = over.body ?? {};
  return { req, res };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.listOAuthClients.mockResolvedValue([view]);
  db.createOAuthClient.mockResolvedValue({ client: view, clientSecret: SECRET });
});

describe('/api/admin/oauth-clients', () => {
  it('requires the admin API-key scope', () => {
    expect(configs).toEqual([{ requiredScopes: [ApiKeyScope.ADMIN] }]);
  });

  it.each(['get', 'post'])('rejects a non-admin on %s with ForbiddenError and touches nothing', async method => {
    const { req, res } = makeReqRes(method.toUpperCase(), {
      user: { isAdmin: false, id: 'u1' },
      body: { name: 'x', redirectUris: ['https://a.example.test/cb'] },
    });
    await expect(handlers[method](req, res)).rejects.toMatchObject({ statusCode: 403 });
    expect(db.listOAuthClients).not.toHaveBeenCalled();
    expect(db.createOAuthClient).not.toHaveBeenCalled();
  });

  it('lists clients without any secret material', async () => {
    const { req, res } = makeReqRes('GET');
    await handlers.get(req, res);
    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body).toEqual([view]);
    expect(JSON.stringify(body)).not.toMatch(/clientSecret/);
  });

  it('creates a client, returns the secret once with no-store, and audits without the secret', async () => {
    const { req, res } = makeReqRes('POST', {
      body: { name: 'My App', redirectUris: ['https://app.example.test/cb'] },
    });
    await handlers.post(req, res);

    expect(res._getStatusCode()).toBe(201);
    expect(res._getJSONData()).toEqual({ client: view, clientSecret: SECRET });
    expect(res.getHeader('Cache-Control')).toBe('no-store');
    expect(db.createOAuthClient).toHaveBeenCalledWith({
      name: 'My App',
      redirectUris: ['https://app.example.test/cb'],
      clientType: 'relying-party',
    });
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'OAUTH_CLIENT_CREATED', adminUserId: 'admin-1' }),
      undefined
    );
    expect(JSON.stringify(logAuditEvent.mock.calls)).not.toContain(SECRET);
  });

  it('rejects an invalid redirect URI with a 400 before reaching the service', async () => {
    const { req, res } = makeReqRes('POST', { body: { name: 'My App', redirectUris: ['javascript:alert(1)'] } });
    await expect(handlers.post(req, res)).rejects.toMatchObject({ statusCode: 400 });
    expect(db.createOAuthClient).not.toHaveBeenCalled();
  });

  it('surfaces a duplicate name as the service ConflictError (409)', async () => {
    const { ConflictError } = await import('@bike4mind/common');
    db.createOAuthClient.mockRejectedValue(new ConflictError('An OAuth client named "My App" already exists'));
    const { req, res } = makeReqRes('POST', {
      body: { name: 'My App', redirectUris: ['https://app.example.test/cb'] },
    });
    await expect(handlers.post(req, res)).rejects.toMatchObject({ statusCode: 409 });
    expect(logAuditEvent).not.toHaveBeenCalled();
  });
});
