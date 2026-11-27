import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ADMIN_AUDIT_CATALOGUE, ConflictError, ForbiddenError, NotFoundError } from '@bike4mind/common';

const { handlers, configs, db, recordAdminActionFromRequest } = vi.hoisted(() => ({
  configs: {} as Record<string, unknown>,
  handlers: {} as Record<string, Record<string, (req: unknown, res: unknown) => unknown>>,
  db: { listOAuthClientRoles: vi.fn(), addOAuthClientRole: vi.fn(), removeOAuthClientRole: vi.fn() },
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
    for (const method of ['get', 'post', 'delete']) {
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
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>()),
  recordAdminActionFromRequest,
}));

const REASON = 'App launches staff roles';
const client = { id: 'c1', clientId: 'b4m_app_0011aabb', name: 'My App', roles: [] };
const ADMIN = { isAdmin: true, id: 'admin-1', username: 'root' };
const NON_ADMIN = { isAdmin: false, id: 'u1' };
const DELEGATE = { isAdmin: false, id: 'd1', adminPermissions: ['settings:manage'] };
const READ_ONLY_DELEGATE = { isAdmin: false, id: 'u2', adminPermissions: ['support:read'] };

function makeReqRes(method: string, over: { user?: unknown; body?: unknown; query?: unknown } = {}) {
  const { req, res } = createMocks({ method });
  (req as { user?: unknown }).user = 'user' in over ? over.user : ADMIN;
  (req as { body?: unknown }).body = over.body;
  (req as { query?: unknown }).query = over.query ?? { id: 'c1', key: 'admin' };
  return { req, res };
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (!handlers.roles) {
    current = 'roles';
    await import('@pages/api/admin/oauth-clients/[id]/roles/index');
    current = 'role';
    await import('@pages/api/admin/oauth-clients/[id]/roles/[key]');
  }
});

describe('route registration', () => {
  it.each(['roles', 'role'])('%s is JWT-only', route => {
    expect(configs[route]).toEqual(expect.objectContaining({ auth: 'jwtOnly' }));
  });

  it('catalogues every action the routes write', () => {
    expect(ADMIN_AUDIT_CATALOGUE['oauth_client.role_added']).toBeDefined();
    expect(ADMIN_AUDIT_CATALOGUE['oauth_client.role_removed']).toBeDefined();
  });
});

describe('GET /api/admin/oauth-clients/[id]/roles', () => {
  it('lists roles and holders for a read-only admin', async () => {
    const view = { roles: [{ key: 'admin', label: 'Admin' }], holders: [] };
    db.listOAuthClientRoles.mockResolvedValue(view);
    const { req, res } = makeReqRes('GET', { user: READ_ONLY_DELEGATE });
    await handlers.roles.get(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual(view);
    expect(db.listOAuthClientRoles).toHaveBeenCalledWith('c1');
  });

  it('rejects a non-admin with 403', async () => {
    const { req, res } = makeReqRes('GET', { user: NON_ADMIN });
    await expect(handlers.roles.get(req, res)).rejects.toMatchObject({ statusCode: 403 });
    expect(db.listOAuthClientRoles).not.toHaveBeenCalled();
  });

  it('requires an id', async () => {
    const { req, res } = makeReqRes('GET', { query: {} });
    await expect(handlers.roles.get(req, res)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('passes a not-found through', async () => {
    db.listOAuthClientRoles.mockRejectedValue(new NotFoundError('OAuth client not found'));
    const { req, res } = makeReqRes('GET');
    await expect(handlers.roles.get(req, res)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('POST /api/admin/oauth-clients/[id]/roles', () => {
  it('adds the role and audits client, role and reason', async () => {
    const role = { key: 'admin', label: 'Admin' };
    db.addOAuthClientRole.mockResolvedValue({ client: { ...client, roles: [role] }, role });
    const { req, res } = makeReqRes('POST', { body: { key: 'admin', label: 'Admin', reason: REASON } });
    await handlers.roles.post(req, res);

    expect(res._getStatusCode()).toBe(201);
    expect(res._getJSONData().roles).toEqual([role]);
    expect(db.addOAuthClientRole).toHaveBeenCalledWith('c1', role);
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(req, {
      action: 'oauth_client.role_added',
      target: { kind: 'oauthClient', id: 'c1', displayName: 'My App' },
      summary: 'added the role admin to the OAuth client',
      reason: REASON,
      details: { clientId: client.clientId, role: 'admin', label: 'Admin' },
    });
  });

  it.each([
    ['a non-admin', NON_ADMIN],
    ['a read-only delegate', READ_ONLY_DELEGATE],
  ])('rejects %s with 403', async (_label, user) => {
    const { req, res } = makeReqRes('POST', { user, body: { key: 'admin', label: 'Admin', reason: REASON } });
    await expect(handlers.roles.post(req, res)).rejects.toMatchObject({ statusCode: 403 });
    expect(db.addOAuthClientRole).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['an invalid key', { key: 'Admin!', label: 'Admin', reason: REASON }],
    ['a missing label', { key: 'admin', reason: REASON }],
    ['a missing reason', { key: 'admin', label: 'Admin' }],
    ['no body', undefined],
  ])('rejects %s with 400', async (_label, body) => {
    const { req, res } = makeReqRes('POST', { body });
    await expect(handlers.roles.post(req, res)).rejects.toMatchObject({ statusCode: 400 });
    expect(db.addOAuthClientRole).not.toHaveBeenCalled();
  });

  it('requires an id', async () => {
    const { req, res } = makeReqRes('POST', { query: { id: '' }, body: { key: 'admin', label: 'A', reason: REASON } });
    await expect(handlers.roles.post(req, res)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('does not audit a rejected duplicate', async () => {
    db.addOAuthClientRole.mockRejectedValue(new ConflictError('dup'));
    const { req, res } = makeReqRes('POST', { body: { key: 'admin', label: 'Admin', reason: REASON } });
    await expect(handlers.roles.post(req, res)).rejects.toBeInstanceOf(ConflictError);
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/admin/oauth-clients/[id]/roles/[key]', () => {
  it('removes the role and audits how many assignments went with it', async () => {
    db.removeOAuthClientRole.mockResolvedValue({
      client,
      role: { key: 'admin', label: 'Admin' },
      removedAssignments: 3,
      removedUserIds: ['u1', 'u2', 'u3'],
    });
    const { req, res } = makeReqRes('DELETE', { body: { reason: REASON } });
    await handlers.role.delete(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(db.removeOAuthClientRole).toHaveBeenCalledWith('c1', 'admin', { actor: ADMIN });
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(req, {
      action: 'oauth_client.role_removed',
      target: { kind: 'oauthClient', id: 'c1', displayName: 'My App' },
      summary: 'removed the role admin from the OAuth client',
      reason: REASON,
      details: {
        clientId: client.clientId,
        role: 'admin',
        label: 'Admin',
        removedAssignments: 3,
        removedUserIds: ['u1', 'u2', 'u3'],
      },
    });
  });

  it('caps the audited user ids and flags the truncation', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `u${i}`);
    db.removeOAuthClientRole.mockResolvedValue({
      client,
      role: { key: 'admin', label: 'Admin' },
      removedAssignments: 150,
      removedUserIds: ids,
    });
    const { req, res } = makeReqRes('DELETE', { body: { reason: REASON } });
    await handlers.role.delete(req, res);
    const details = recordAdminActionFromRequest.mock.calls[0][1].details;
    expect(details.removedUserIds).toEqual(ids.slice(0, 100));
    expect(details.removedUserIdsTruncated).toBe(true);
    expect(details.removedAssignments).toBe(150);
  });

  it('passes the acting delegate to the removal and surfaces its refusal without auditing', async () => {
    db.removeOAuthClientRole.mockRejectedValue(
      new ForbiddenError('Only full administrators can remove an app role from users with admin access')
    );
    const { req, res } = makeReqRes('DELETE', { user: DELEGATE, body: { reason: REASON } });
    await expect(handlers.role.delete(req, res)).rejects.toMatchObject({ statusCode: 403 });
    expect(db.removeOAuthClientRole).toHaveBeenCalledWith('c1', 'admin', { actor: DELEGATE });
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-admin', NON_ADMIN],
    ['a read-only delegate', READ_ONLY_DELEGATE],
  ])('rejects %s with 403', async (_label, user) => {
    const { req, res } = makeReqRes('DELETE', { user, body: { reason: REASON } });
    await expect(handlers.role.delete(req, res)).rejects.toMatchObject({ statusCode: 403 });
    expect(db.removeOAuthClientRole).not.toHaveBeenCalled();
  });

  it.each([
    ['no id', { key: 'admin' }, { reason: REASON }],
    ['no key', { id: 'c1' }, { reason: REASON }],
    ['no reason', { id: 'c1', key: 'admin' }, undefined],
  ])('rejects %s with 400', async (_label, query, body) => {
    const { req, res } = makeReqRes('DELETE', { query, body });
    await expect(handlers.role.delete(req, res)).rejects.toMatchObject({ statusCode: 400 });
    expect(db.removeOAuthClientRole).not.toHaveBeenCalled();
  });

  it('passes a not-found through without auditing', async () => {
    db.removeOAuthClientRole.mockRejectedValue(new NotFoundError('Role not found on this client'));
    const { req, res } = makeReqRes('DELETE', { body: { reason: REASON } });
    await expect(handlers.role.delete(req, res)).rejects.toBeInstanceOf(NotFoundError);
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });
});
