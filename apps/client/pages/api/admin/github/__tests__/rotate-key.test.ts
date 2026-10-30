// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Route = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  findSystemDefault: vi.fn(),
  update: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, Route> = {};
    const chain = Object.assign((req: unknown, res: unknown) => routes[(req as { method: string }).method](req, res), {
      use: () => chain,
      post: (fn: Route) => ((routes.POST = fn), chain),
    });
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  orgGitHubConnectionRepository: { findSystemDefault: h.findSystemDefault, update: h.update },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/server-utils/security/secretEncryption', () => ({ encryptSecret: () => 'encrypted-blob' }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { SECRET_ENCRYPTION_KEY: 'test-key' } }));
vi.mock('@server/utils/validators', () => ({ validatePrivateKeyFormat: () => true }));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    info = vi.fn();
    error = vi.fn();
  },
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import handler from '../rotate-key';

const PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nplaintext\n-----END RSA PRIVATE KEY-----';

const rotate = async () => {
  const { req, res } = createMocks({ method: 'POST', body: { privateKey: PRIVATE_KEY } });
  (req as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
  await (handler as unknown as Route)(req, res);
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.findSystemDefault.mockResolvedValue({ id: 'conn-1', connectionType: 'github_app', appId: '123' });
  h.update.mockResolvedValue({ id: 'conn-1' });
  h.audit.mockResolvedValue(null);
});

describe('POST /api/admin/github/rotate-key admin audit', () => {
  it('records a strict key_rotated entry without key material', async () => {
    const { req, res } = await rotate();

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'integration.github_connection.key_rotated',
      target: { kind: 'settings', id: 'conn-1' },
    });
    const serialized = JSON.stringify(h.audit.mock.calls[0][1]);
    expect(serialized).not.toContain('PRIVATE KEY');
    expect(serialized).not.toContain('encrypted-blob');
    expect(h.update.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('fails with NotFoundError and records nothing when the update matches no connection', async () => {
    h.update.mockResolvedValue(null);

    await expect(rotate()).rejects.toMatchObject({ name: 'NotFoundError', statusCode: 404 });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('does not report success when the audit write rejects', async () => {
    h.audit.mockRejectedValue(new Error('audit down'));

    await expect(rotate()).rejects.toThrow('audit down');
  });
});
