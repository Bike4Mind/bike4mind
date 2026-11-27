import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ADMIN_AUDIT_CATALOGUE, BadRequestError, NotFoundError } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  config: null as unknown,
  handlers: {} as Record<string, (req: unknown, res: unknown) => unknown>,
  db: {
    listUserOAuthClientRoles: vi.fn(),
    assignOAuthClientRole: vi.fn(),
    unassignOAuthClientRole: vi.fn(),
    userRepository: { findById: vi.fn() },
  },
  audit: vi.fn(),
}));

// adminApi stays real: the permission guard it installs is part of what is under test.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    h.config = config;
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const chain: Record<string, unknown> = {
      use: (middleware: (req: unknown, res: unknown, next: () => void) => void) => {
        middlewares.push(middleware);
        return chain;
      },
    };
    for (const method of ['get', 'post', 'delete']) {
      chain[method] = (fn: (req: unknown, res: unknown) => unknown) => {
        h.handlers[method] = async (req: unknown, res: unknown) => {
          for (const middleware of middlewares) middleware(req, res, () => undefined);
          return fn(req, res);
        };
        return chain;
      };
    }
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => h.db);
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>()),
  recordAdminActionFromRequest: h.audit,
}));

await import('../oauth-client-roles');

const REASON = 'Staff member of the app';
const ADMIN = { isAdmin: true, id: 'admin-1', username: 'root' };
const DELEGATE = { isAdmin: false, id: 'd1', adminPermissions: ['settings:manage'] };
const READ_ONLY_DELEGATE = { isAdmin: false, id: 'd2', adminPermissions: ['support:read'] };
const NON_ADMIN = { isAdmin: false, id: 'u1' };
const client = { id: 'c1', clientId: 'b4m_app_0011aabb', name: 'My App' };
const role = { key: 'admin', label: 'Admin' };
const user = { id: 'user-1', email: 'ada@example.test', name: 'Ada' };
const body = { clientId: client.clientId, role: 'admin', reason: REASON };

function makeReqRes(method: string, over: { user?: unknown; body?: unknown; query?: unknown } = {}) {
  const { req, res } = createMocks({ method });
  (req as { user?: unknown }).user = 'user' in over ? over.user : ADMIN;
  (req as { body?: unknown }).body = 'body' in over ? over.body : body;
  (req as { query?: unknown }).query = over.query ?? { userId: 'user-1' };
  return { req, res };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
  h.db.userRepository.findById.mockResolvedValue({ id: 'user-1', isAdmin: false });
});

describe('route registration', () => {
  it('is JWT-only and catalogues both actions', () => {
    expect(h.config).toEqual(expect.objectContaining({ auth: 'jwtOnly' }));
    expect(ADMIN_AUDIT_CATALOGUE['oauth_client.role_assigned']).toBeDefined();
    expect(ADMIN_AUDIT_CATALOGUE['oauth_client.role_unassigned']).toBeDefined();
  });
});

describe('GET', () => {
  it('lists the user roles per client for a read-only admin', async () => {
    h.db.listUserOAuthClientRoles.mockResolvedValue([{ clientId: client.clientId }]);
    const { req, res } = makeReqRes('GET', { user: READ_ONLY_DELEGATE });
    await h.handlers.get(req, res);
    expect(res._getJSONData()).toEqual([{ clientId: client.clientId }]);
    expect(h.db.listUserOAuthClientRoles).toHaveBeenCalledWith('user-1');
  });

  it('rejects a non-admin with 403', async () => {
    const { req, res } = makeReqRes('GET', { user: NON_ADMIN });
    await expect(h.handlers.get(req, res)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.db.listUserOAuthClientRoles).not.toHaveBeenCalled();
  });

  it('requires a user id', async () => {
    const { req, res } = makeReqRes('GET', { query: {} });
    await expect(h.handlers.get(req, res)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('POST (assign)', () => {
  it('assigns, audits the client, role and user, and answers 201', async () => {
    h.db.assignOAuthClientRole.mockResolvedValue({ client, user, role, created: true });
    const { req, res } = makeReqRes('POST');
    await h.handlers.post(req, res);

    expect(res._getStatusCode()).toBe(201);
    expect(res._getJSONData()).toEqual({ clientId: client.clientId, role: 'admin', created: true });
    expect(h.db.assignOAuthClientRole).toHaveBeenCalledWith({
      userId: 'user-1',
      clientId: client.clientId,
      role: 'admin',
      assignedBy: 'admin-1',
    });
    expect(h.audit).toHaveBeenCalledWith(req, {
      action: 'oauth_client.role_assigned',
      target: { kind: 'user', id: 'user-1', displayName: 'ada@example.test' },
      summary: 'assigned the role admin on My App to the user',
      reason: REASON,
      details: {
        oauthClientId: 'c1',
        clientId: client.clientId,
        clientName: 'My App',
        role: 'admin',
        label: 'Admin',
        userId: 'user-1',
        userEmail: 'ada@example.test',
      },
    });
  });

  it('is idempotent: a repeat answers 200 and writes no audit entry', async () => {
    h.db.assignOAuthClientRole.mockResolvedValue({ client, user, role, created: false });
    const { req, res } = makeReqRes('POST');
    await h.handlers.post(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it.each([
    ['by name without an email', { ...user, email: null }, 'Ada'],
    ['by id without an email or name', { ...user, email: null, name: null }, 'user-1'],
  ])('names the target user %s', async (_label, target, displayName) => {
    h.db.assignOAuthClientRole.mockResolvedValue({ client, user: target, role, created: true });
    const { req, res } = makeReqRes('POST');
    await h.handlers.post(req, res);
    expect(h.audit).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ target: { kind: 'user', id: 'user-1', displayName } })
    );
  });

  it.each([
    ['a non-admin', NON_ADMIN],
    ['a read-only delegate', READ_ONLY_DELEGATE],
  ])('rejects %s with 403', async (_label, actor) => {
    const { req, res } = makeReqRes('POST', { user: actor });
    await expect(h.handlers.post(req, res)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.db.assignOAuthClientRole).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('refuses a delegated admin changing an account with admin access', async () => {
    h.db.userRepository.findById.mockResolvedValue({ id: 'user-1', isAdmin: true });
    const { req, res } = makeReqRes('POST', { user: DELEGATE });
    await expect(h.handlers.post(req, res)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.db.assignOAuthClientRole).not.toHaveBeenCalled();
  });

  it.each([
    ['a bad role key', { ...body, role: 'Admin' }],
    ['no client', { role: 'admin', reason: REASON }],
    ['no reason', { clientId: client.clientId, role: 'admin' }],
    ['no body', undefined],
  ])('rejects %s with 400', async (_label, payload) => {
    const { req, res } = makeReqRes('POST', { body: payload });
    await expect(h.handlers.post(req, res)).rejects.toMatchObject({ statusCode: 400 });
    expect(h.db.assignOAuthClientRole).not.toHaveBeenCalled();
  });

  it('404s for an unknown user', async () => {
    h.db.userRepository.findById.mockResolvedValue(null);
    const { req, res } = makeReqRes('POST');
    await expect(h.handlers.post(req, res)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('passes the undefined-role rejection through without auditing', async () => {
    h.db.assignOAuthClientRole.mockRejectedValue(new BadRequestError('This client does not offer a role "admin"'));
    const { req, res } = makeReqRes('POST');
    await expect(h.handlers.post(req, res)).rejects.toBeInstanceOf(BadRequestError);
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe('DELETE (unassign)', () => {
  it('removes the assignment and audits it', async () => {
    h.db.unassignOAuthClientRole.mockResolvedValue({ client, user, role });
    const { req, res } = makeReqRes('DELETE');
    await h.handlers.delete(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(h.db.unassignOAuthClientRole).toHaveBeenCalledWith({
      userId: 'user-1',
      clientId: client.clientId,
      role: 'admin',
    });
    expect(h.audit).toHaveBeenCalledWith(req, {
      action: 'oauth_client.role_unassigned',
      target: { kind: 'user', id: 'user-1', displayName: 'ada@example.test' },
      summary: 'removed the role admin on My App from the user',
      reason: REASON,
      details: {
        oauthClientId: 'c1',
        clientId: client.clientId,
        clientName: 'My App',
        role: 'admin',
        label: 'Admin',
        userId: 'user-1',
        userEmail: 'ada@example.test',
      },
    });
  });

  it('names a user without an email or name by id', async () => {
    h.db.unassignOAuthClientRole.mockResolvedValue({ client, user: { ...user, email: null, name: null }, role });
    const { req, res } = makeReqRes('DELETE');
    await h.handlers.delete(req, res);
    expect(h.audit).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ target: { kind: 'user', id: 'user-1', displayName: 'user-1' } })
    );
  });

  it.each([
    ['a non-admin', NON_ADMIN],
    ['a read-only delegate', READ_ONLY_DELEGATE],
  ])('rejects %s with 403', async (_label, actor) => {
    const { req, res } = makeReqRes('DELETE', { user: actor });
    await expect(h.handlers.delete(req, res)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.db.unassignOAuthClientRole).not.toHaveBeenCalled();
  });

  it('rejects a missing reason with 400', async () => {
    const { req, res } = makeReqRes('DELETE', { body: { clientId: client.clientId, role: 'admin' } });
    await expect(h.handlers.delete(req, res)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('passes a not-held 404 through without auditing', async () => {
    h.db.unassignOAuthClientRole.mockRejectedValue(new NotFoundError('This user does not hold that role'));
    const { req, res } = makeReqRes('DELETE');
    await expect(h.handlers.delete(req, res)).rejects.toBeInstanceOf(NotFoundError);
    expect(h.audit).not.toHaveBeenCalled();
  });
});
