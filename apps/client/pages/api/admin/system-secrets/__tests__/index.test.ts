// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  findAll: vi.fn(),
  resolveSecret: vi.fn(),
  findBySecretName: vi.fn(),
  updateSecret: vi.fn(),
  upsertSecret: vi.fn(),
  clearSecretCache: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => unknown> = [];
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) await middleware(req, res, () => undefined);
        return routes[(req as { method?: string }).method ?? 'GET']?.(req, res);
      },
      {
        use: (fn: (req: unknown, res: unknown, next: () => void) => unknown) => (middlewares.push(fn), chain),
        get: (fn: (req: unknown, res: unknown) => unknown) => ((routes.GET = fn), chain),
        post: (fn: (req: unknown, res: unknown) => unknown) => ((routes.POST = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  systemSecretRepository: {
    findAll: h.findAll,
    findBySecretName: h.findBySecretName,
    updateSecret: h.updateSecret,
    upsertSecret: h.upsertSecret,
  },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@server/managers/systemSecretsManager', () => ({
  clearSecretCache: h.clearSecretCache,
  getResolvableSecrets: () => ({ OPENAI_API_KEY: { category: 'llm', description: 'OpenAI key' } }),
  RESOLVABLE_SECRETS: {
    OPENAI_API_KEY: { category: 'llm', description: 'OpenAI key' },
    MAIL_PASSWORD: { category: 'mail', description: 'SMTP password' },
  },
  TIER1_SECRETS: new Set(['MONGODB_URI']),
  resolveSecret: h.resolveSecret,
}));
vi.mock('@bike4mind/server-utils/security/secretEncryption', () => ({
  encryptSecret: () => 'encrypted-blob',
  isValidEncryptionKey: () => true,
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { SECRET_ENCRYPTION_KEY: 'test-key' } }));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import handler from '../index';

const SECRET_VALUE = 'sk-test-plaintext-value';

const post = async () => {
  const { req, res } = createMocks({ method: 'POST', body: { secretName: 'OPENAI_API_KEY', value: SECRET_VALUE } });
  (req as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.findBySecretName.mockResolvedValue(null);
  h.upsertSecret.mockResolvedValue({ id: 'secret-1' });
  h.updateSecret.mockResolvedValue({ id: 'secret-1' });
  h.audit.mockResolvedValue(null);
});

describe('POST /api/admin/system-secrets admin audit', () => {
  it('records a strict upsert entry for a new secret without the value', async () => {
    const { req, res } = await post();

    expect(res._getStatusCode()).toBe(201);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.system_secret.upserted',
      target: { kind: 'settings', id: 'OPENAI_API_KEY', displayName: 'OPENAI_API_KEY' },
      details: { created: true },
    });
    const serialized = JSON.stringify(h.audit.mock.calls[0][1]);
    expect(serialized).not.toContain(SECRET_VALUE);
    expect(serialized).not.toContain('encrypted-blob');
    expect(h.upsertSecret.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('records created: false when updating an existing secret', async () => {
    h.findBySecretName.mockResolvedValue({ id: 'secret-1', secretName: 'OPENAI_API_KEY' });

    const { res } = await post();

    expect(res._getStatusCode()).toBe(200);
    expect(h.updateSecret).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({ details: { created: false } });
  });

  it('returns 500 and keeps the old cached value when the audit write rejects', async () => {
    h.audit.mockRejectedValue(new Error('audit down'));

    const { res } = await post();

    expect(res._getStatusCode()).toBe(500);
    expect(res._getJSONData()).not.toHaveProperty('success');
    expect(h.clearSecretCache).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/system-secrets', () => {
  const get = async () => {
    const { req, res } = createMocks({ method: 'GET' });
    (req as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
    return res._getJSONData().secrets as Array<{ secretName: string; isUnused: boolean; dbRecord: unknown }>;
  };

  beforeEach(() => {
    h.resolveSecret.mockResolvedValue({ value: 'stored-value', source: 'database', warnings: [] });
  });

  it('leaves out a setting the stage does not read when nothing is stored for it', async () => {
    h.findAll.mockResolvedValue([]);

    const secrets = await get();

    expect(secrets.map(s => s.secretName)).toEqual(['OPENAI_API_KEY']);
    expect(secrets[0].isUnused).toBe(false);
  });

  it('keeps a stored override for such a setting listed and marked unused, so it can be removed', async () => {
    h.findAll.mockResolvedValue([{ id: 'db-9', secretName: 'MAIL_PASSWORD', source: 'gui_configured' }]);

    const secrets = await get();

    const stored = secrets.find(s => s.secretName === 'MAIL_PASSWORD');
    expect(stored).toMatchObject({ isUnused: true, dbRecord: { id: 'db-9' } });
    expect(secrets.find(s => s.secretName === 'OPENAI_API_KEY')?.isUnused).toBe(false);
  });
});

describe('non-admin requests', () => {
  it.each(['GET', 'POST'] as const)('%s is refused before any secret work', async method => {
    const { req, res } = createMocks({ method, body: { secretName: 'OPENAI_API_KEY', value: SECRET_VALUE } });
    (req as Record<string, unknown>).user = { id: 'user-1', isAdmin: false };

    await expect((handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res)).rejects.toThrow(
      /missing permission/i
    );
    expect(h.findBySecretName).not.toHaveBeenCalled();
    expect(h.upsertSecret).not.toHaveBeenCalled();
  });
});
