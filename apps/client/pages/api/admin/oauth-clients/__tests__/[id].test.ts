import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope, BadRequestError, NotFoundError } from '@bike4mind/common';

const { handlers, configs, db, recordAdminActionFromRequest } = vi.hoisted(() => ({
  configs: {} as Record<string, unknown>,
  handlers: {} as Record<string, Record<string, (req: unknown, res: unknown) => unknown>>,
  db: { updateOAuthClient: vi.fn(), rotateOAuthClientSecret: vi.fn() },
  recordAdminActionFromRequest: vi.fn().mockResolvedValue(null),
}));

// Each route module calls baseApi() once; record its handlers under the module being imported.
let current = '';
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    configs[current] = config;
    const bucket: Record<string, (req: unknown, res: unknown) => unknown> = {};
    handlers[current] = bucket;
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const chain: Record<string, unknown> = {
      use: (middleware: (req: unknown, res: unknown, next: () => void) => void) => {
        middlewares.push(middleware);
        return chain;
      },
    };
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      chain[method] = (fn: (req: unknown, res: unknown) => unknown) => {
        bucket[method] = async (req: unknown, res: unknown) => {
          for (const middleware of middlewares) middleware(req, res, () => undefined);
          return fn(req, res);
        };
        return chain;
      };
    }
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => db);
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest }));

const view = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  clientId: 'b4m_my_app_0011aabb',
  name: 'My App',
  clientType: 'relying-party',
  tokenEndpointAuthMethod: 'client_secret_post',
  redirectUris: ['https://app.example.test/cb'],
  allowedScopes: ['openid'],
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});
const SECRET = 'rotated-plaintext-secret';

function makeReqRes(method: string, over: { user?: unknown; body?: unknown; query?: unknown } = {}) {
  const { req, res } = createMocks({ method });
  (req as { user?: unknown }).user = 'user' in over ? over.user : { isAdmin: true, id: 'admin-1', username: 'root' };
  (req as { body?: unknown }).body = over.body ?? {};
  (req as { query?: unknown }).query = over.query ?? { id: 'c1' };
  return { req, res };
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (!handlers.update) {
    current = 'update';
    await import('@pages/api/admin/oauth-clients/[id]/index');
    current = 'rotate';
    await import('@pages/api/admin/oauth-clients/[id]/rotate-secret');
  }
});

describe('route registration', () => {
  it.each(['update', 'rotate'])('%s requires the admin API-key scope', route => {
    expect(configs[route]).toEqual(expect.objectContaining({ requiredScopes: [ApiKeyScope.ADMIN] }));
  });
});

describe('PATCH /api/admin/oauth-clients/[id]', () => {
  it('rejects a non-admin with 403', async () => {
    const { req, res } = makeReqRes('PATCH', { user: { isAdmin: false, id: 'u1' }, body: { isActive: false } });
    await expect(handlers.update.patch(req, res)).rejects.toMatchObject({ statusCode: 403 });
    expect(db.updateOAuthClient).not.toHaveBeenCalled();
  });

  it('updates redirect URIs and audits the before/after diff', async () => {
    const uris = ['https://app.example.test/cb2'];
    db.updateOAuthClient.mockResolvedValue({ before: view(), after: view({ redirectUris: uris }) });
    const { req, res } = makeReqRes('PATCH', { body: { redirectUris: uris } });
    await handlers.update.patch(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().redirectUris).toEqual(uris);
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'oauth_client.updated',
        target: expect.objectContaining({ kind: 'oauthClient', id: 'c1' }),
        changes: [
          { field: 'redirectUris', before: ['https://app.example.test/cb'], after: uris },
          { field: 'isActive', before: true, after: true },
        ],
      })
    );
  });

  it('audits a deactivation as its own event', async () => {
    db.updateOAuthClient.mockResolvedValue({ before: view(), after: view({ isActive: false }) });
    const { req, res } = makeReqRes('PATCH', { body: { isActive: false } });
    await handlers.update.patch(req, res);
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ action: 'oauth_client.deactivated' })
    );
  });

  it('audits re-activating an inactive client as its own event', async () => {
    db.updateOAuthClient.mockResolvedValue({ before: view({ isActive: false }), after: view() });
    const { req, res } = makeReqRes('PATCH', { body: { isActive: true } });
    await handlers.update.patch(req, res);
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ action: 'oauth_client.activated' })
    );
  });

  it('audits an unchanged isActive as a plain update', async () => {
    db.updateOAuthClient.mockResolvedValue({ before: view(), after: view() });
    const { req, res } = makeReqRes('PATCH', { body: { isActive: true } });
    await handlers.update.patch(req, res);
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ action: 'oauth_client.updated' })
    );
  });

  it.each([{}, { id: ['a', 'b'] }])('rejects a missing or non-string id %j with 400', async query => {
    const { req, res } = makeReqRes('PATCH', { body: { isActive: false }, query });
    await expect(handlers.update.patch(req, res)).rejects.toMatchObject({ statusCode: 400 });
    expect(db.updateOAuthClient).not.toHaveBeenCalled();
  });

  it('returns 404 and writes no audit event when the client does not exist', async () => {
    db.updateOAuthClient.mockRejectedValue(new NotFoundError('OAuth client not found'));
    const { req, res } = makeReqRes('PATCH', { body: { isActive: false } });
    await expect(handlers.update.patch(req, res)).rejects.toMatchObject({ statusCode: 404 });
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('rejects a body that tries to change anything but redirect URIs and active state', async () => {
    const { req, res } = makeReqRes('PATCH', { body: { clientType: 'first-party' } });
    await expect(handlers.update.patch(req, res)).rejects.toMatchObject({ statusCode: 400 });
    expect(db.updateOAuthClient).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/oauth-clients/[id]/rotate-secret', () => {
  it('rejects a non-admin with 403', async () => {
    const { req, res } = makeReqRes('POST', { user: { isAdmin: false, id: 'u1' } });
    await expect(handlers.rotate.post(req, res)).rejects.toMatchObject({ statusCode: 403 });
    expect(db.rotateOAuthClientSecret).not.toHaveBeenCalled();
  });

  it('returns the new secret once and audits without it', async () => {
    db.rotateOAuthClientSecret.mockResolvedValue({ client: view(), clientSecret: SECRET });
    const { req, res } = makeReqRes('POST');
    await handlers.rotate.post(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().clientSecret).toBe(SECRET);
    expect(res.getHeader('Cache-Control')).toBe('no-store');
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ action: 'oauth_client.secret_rotated' })
    );
    expect(JSON.stringify(recordAdminActionFromRequest.mock.calls.map(([, input]) => input))).not.toContain(SECRET);
  });

  it.each([{}, { id: ['a', 'b'] }])('rejects a missing or non-string id %j with 400', async query => {
    const { req, res } = makeReqRes('POST', { query });
    await expect(handlers.rotate.post(req, res)).rejects.toMatchObject({ statusCode: 400 });
    expect(db.rotateOAuthClientSecret).not.toHaveBeenCalled();
  });

  it('returns 404 and writes no audit event when the client does not exist', async () => {
    db.rotateOAuthClientSecret.mockRejectedValue(new NotFoundError('OAuth client not found'));
    const { req, res } = makeReqRes('POST');
    await expect(handlers.rotate.post(req, res)).rejects.toMatchObject({ statusCode: 404 });
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('returns 400 and writes no audit event when the client is public', async () => {
    db.rotateOAuthClientSecret.mockRejectedValue(new BadRequestError('public client'));
    const { req, res } = makeReqRes('POST');
    await expect(handlers.rotate.post(req, res)).rejects.toMatchObject({ statusCode: 400 });
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });
});
