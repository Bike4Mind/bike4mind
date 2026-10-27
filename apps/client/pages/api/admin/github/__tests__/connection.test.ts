// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Route = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  findSystemDefault: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, Route> = {};
    const chain = Object.assign((req: unknown, res: unknown) => routes[(req as { method: string }).method](req, res), {
      use: () => chain,
      get: (fn: Route) => ((routes.GET = fn), chain),
      post: (fn: Route) => ((routes.POST = fn), chain),
      put: (fn: Route) => ((routes.PUT = fn), chain),
      delete: (fn: Route) => ((routes.DELETE = fn), chain),
    });
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  orgGitHubConnectionRepository: {
    findSystemDefault: h.findSystemDefault,
    findSystemDefaultWithCredentials: vi.fn().mockResolvedValue(null),
    create: h.create,
    update: h.update,
    delete: h.remove,
  },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/server-utils/security/secretEncryption', () => ({
  encryptSecret: () => 'encrypted-blob',
  isEncrypted: () => false,
  decryptSecret: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { SECRET_ENCRYPTION_KEY: 'test-key' } }));
vi.mock('@server/utils/validators', () => ({ validatePrivateKeyFormat: () => true }));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    info = vi.fn();
    error = vi.fn();
  },
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import handler from '../connection';

const PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nplaintext\n-----END RSA PRIVATE KEY-----';

const connectionDoc = {
  id: 'conn-1',
  organizationId: null,
  connectionType: 'github_app',
  appId: '123',
  installationId: '456',
  connectedBy: 'admin-1',
  connectedAt: new Date('2026-01-01T00:00:00Z'),
  allowedRepositories: ['acme/one'],
  enabled: true,
  isSystemDefault: true,
};

const call = async (method: 'POST' | 'PUT' | 'DELETE', body?: Record<string, unknown>) => {
  const { req, res } = createMocks({ method, body });
  (req as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
  await (handler as unknown as Route)(req, res);
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
  h.create.mockResolvedValue(connectionDoc);
  h.update.mockResolvedValue({ ...connectionDoc, enabled: false });
  h.remove.mockResolvedValue(true);
});

describe('/api/admin/github/connection admin audit', () => {
  const createBody = {
    connectionType: 'github_app',
    appId: '123',
    installationId: '456',
    privateKey: PRIVATE_KEY,
    allowedRepositories: ['acme/one'],
  };

  it('POST records a strict created entry without the private key', async () => {
    h.findSystemDefault.mockResolvedValue(null);

    const { req, res } = await call('POST', createBody);

    expect(res._getStatusCode()).toBe(201);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'integration.github_connection.created',
      target: { kind: 'settings', id: 'conn-1' },
      details: { connectionType: 'github_app', appId: '123', installationId: '456', allowedRepositories: ['acme/one'] },
    });
    const serialized = JSON.stringify(h.audit.mock.calls[0][1]);
    expect(serialized).not.toContain('PRIVATE KEY');
    expect(serialized).not.toContain('encrypted-blob');
    expect(h.create.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('POST does not report success when the audit write rejects', async () => {
    h.findSystemDefault.mockResolvedValue(null);
    h.audit.mockRejectedValue(new Error('audit down'));

    await expect(call('POST', createBody)).rejects.toThrow('audit down');
  });

  it('PUT records a strict updated entry with the diff of changed fields', async () => {
    h.findSystemDefault.mockResolvedValue(connectionDoc);

    const { res } = await call('PUT', { enabled: false, allowedRepositories: ['acme/one'] });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'integration.github_connection.updated',
      target: { kind: 'settings', id: 'conn-1' },
    });
    expect(h.audit.mock.calls[0][1].changes).toEqual([{ field: 'enabled', before: true, after: false }]);
    expect(h.update.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('PUT does not report success when the audit write rejects', async () => {
    h.findSystemDefault.mockResolvedValue(connectionDoc);
    h.audit.mockRejectedValue(new Error('audit down'));

    await expect(call('PUT', { enabled: false })).rejects.toThrow('audit down');
  });

  it('DELETE records a strict deleted entry', async () => {
    h.findSystemDefault.mockResolvedValue(connectionDoc);

    const { res } = await call('DELETE');

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'integration.github_connection.deleted',
      target: { kind: 'settings', id: 'conn-1' },
      details: { connectionType: 'github_app' },
    });
    expect(h.remove.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('DELETE does not report success when the audit write rejects', async () => {
    h.findSystemDefault.mockResolvedValue(connectionDoc);
    h.audit.mockRejectedValue(new Error('audit down'));

    await expect(call('DELETE')).rejects.toThrow('audit down');
  });
});
