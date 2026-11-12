import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { AdminAiConfigSchema } from '@bike4mind/common';

const h = vi.hoisted(() => ({ read: vi.fn(), config: vi.fn(), write: vi.fn(), audit: vi.fn(), validate: vi.fn() }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => unknown> = [];
    const chain = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) await middleware(req, res, () => undefined);
        return routes[(req as { method: string }).method]?.(req, res);
      },
      {
        use: (fn: (typeof middlewares)[number]) => (middlewares.push(fn), chain),
        get: (fn: (req: unknown, res: unknown) => unknown) => ((routes.GET = fn), chain),
        put: (fn: (req: unknown, res: unknown) => unknown) => ((routes.PUT = fn), chain),
        post: (fn: (req: unknown, res: unknown) => unknown) => ((routes.POST = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  AdminSettings: { findOneAndUpdate: h.write },
  AdminAiClassModel: {},
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@server/admin/ai/operations', () => ({ getAdminAiOperations: h.read, loadAdminAiConfig: h.config }));
vi.mock('@server/admin/ai/readiness', () => ({
  validateAdminAiConfigPromotion: h.validate,
  ADMIN_AI_CLASS_REGISTRY: [],
}));
vi.mock('@bike4mind/server-utils/utils/adminSettingsAudit', () => ({ recordAdminSettingChange: h.audit }));
vi.mock('@bike4mind/utils', () => ({ invalidateSettingsCache: vi.fn() }));
import handler from '../ai-operations';
const call = async (method: 'GET' | 'PUT' | 'POST', user: object, body: unknown = {}) => {
  const { req, res } = createMocks({ method, body });
  (req as Record<string, unknown>).user = user;
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};
beforeEach(() => {
  vi.clearAllMocks();
  h.config.mockResolvedValue(AdminAiConfigSchema.parse({}));
  h.read.mockResolvedValue({ ok: true });
});
describe('AI operations authorization and audited controls', () => {
  it.each(['GET', 'PUT', 'POST'] as const)('denies %s before any work without settings permission', async method => {
    await expect(call(method, { isAdmin: false })).rejects.toThrow(/missing permission/i);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });
  it('accepts settings delegates and audits before returning the saved controls', async () => {
    const config = AdminAiConfigSchema.parse({ monthlyCapUsd: 150 });
    await call('PUT', { isAdmin: false, adminPermissions: ['settings:manage'] }, config);
    expect(h.validate).toHaveBeenCalledWith(config);
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ settingName: 'adminAiConfig', after: config })
    );
    expect(h.audit.mock.invocationCallOrder[0]).toBeLessThan(h.read.mock.invocationCallOrder[0]);
  });
  it('does not report success if the audit fails', async () => {
    h.audit.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(call('PUT', { isAdmin: true }, AdminAiConfigSchema.parse({}))).rejects.toThrow('audit unavailable');
    expect(h.read).not.toHaveBeenCalled();
  });
});
