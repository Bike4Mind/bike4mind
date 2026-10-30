// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  findBySecretName: vi.fn(),
  updateSecret: vi.fn(),
  upsertSecret: vi.fn(),
  clearSecretCache: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => routes[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        get: (fn: (req: unknown, res: unknown) => unknown) => ((routes.GET = fn), chain),
        post: (fn: (req: unknown, res: unknown) => unknown) => ((routes.POST = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  systemSecretRepository: {
    findBySecretName: h.findBySecretName,
    updateSecret: h.updateSecret,
    upsertSecret: h.upsertSecret,
  },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@server/managers/systemSecretsManager', () => ({
  clearSecretCache: h.clearSecretCache,
  RESOLVABLE_SECRETS: { OPENAI_API_KEY: { category: 'llm', description: 'OpenAI key' } },
  TIER1_SECRETS: new Set(['MONGODB_URI']),
  resolveSecret: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/security/secretEncryption', () => ({
  encryptSecret: () => 'encrypted-blob',
  isValidEncryptionKey: () => true,
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { SECRET_ENCRYPTION_KEY: 'test-key' } }));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import { Logger } from '@bike4mind/observability';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
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

// A non-admin probe is an expected client error: it must reach the shared error handler
// (403, logged at warn) instead of the route's own catch, which logs at error and pages.
describe('non-admin access', () => {
  it.each(['GET', 'POST'] as const)('%s rejects with ForbiddenError without logging an error', async method => {
    const { req, res } = createMocks({ method, body: { secretName: 'OPENAI_API_KEY', value: SECRET_VALUE } });
    (req as Record<string, unknown>).user = { id: 'user-1', isAdmin: false };

    await expect(
      (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res)
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(Logger.error).not.toHaveBeenCalled();
    expect(h.upsertSecret).not.toHaveBeenCalled();
  });
});
