// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  findById: vi.fn(),
  deleteSecret: vi.fn(),
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
        delete: (fn: (req: unknown, res: unknown) => unknown) => ((routes.DELETE = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  systemSecretRepository: { findById: h.findById, deleteSecret: h.deleteSecret },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@server/managers/systemSecretsManager', () => ({
  clearSecretCache: h.clearSecretCache,
  resolveSecret: vi.fn(),
}));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import handler from '../[id]';

const remove = async () => {
  const { req, res } = createMocks({ method: 'DELETE', query: { id: 'secret-1' } });
  (req as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.findById.mockResolvedValue({ id: 'secret-1', secretName: 'OPENAI_API_KEY' });
  h.deleteSecret.mockResolvedValue(true);
  h.audit.mockResolvedValue(null);
});

describe('DELETE /api/admin/system-secrets/[id] admin audit', () => {
  it('records a strict deleted entry after the delete', async () => {
    const { req, res } = await remove();

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.system_secret.deleted',
      target: { kind: 'settings', id: 'OPENAI_API_KEY', displayName: 'OPENAI_API_KEY' },
    });
    expect(h.deleteSecret.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('does not audit when nothing was deleted', async () => {
    h.deleteSecret.mockResolvedValue(false);

    const { res } = await remove();

    expect(res._getStatusCode()).toBe(404);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('returns 500 and leaves the cache alone when the audit write rejects', async () => {
    h.audit.mockRejectedValue(new Error('audit down'));

    const { res } = await remove();

    expect(res._getStatusCode()).toBe(500);
    expect(res._getJSONData()).not.toHaveProperty('success');
    expect(h.clearSecretCache).not.toHaveBeenCalled();
  });
});
