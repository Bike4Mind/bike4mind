import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: any, res: any) => unknown;
const { handlers } = vi.hoisted(() => ({ handlers: {} as Record<string, Record<string, Handler>> }));
const state = vi.hoisted(() => ({ current: '' }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const bucket: Record<string, Handler> = {};
    handlers[state.current] = bucket;
    const chain: any = { use: () => chain };
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      chain[method] = (fn: Handler) => {
        bucket[method] = fn;
        return chain;
      };
    }
    return chain;
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: vi.fn().mockResolvedValue(null) }));
const service = vi.hoisted(() => ({
  getConfigHistory: vi.fn(),
  getConfig: vi.fn(),
  restoreFromHistory: vi.fn(),
}));
vi.mock('@client/services/whatsNewConfigService', () => ({ WhatsNewConfigService: service }));

import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

state.current = 'restore';
await import('../restore');

describe('POST /api/admin/whats-new-config/restore', () => {
  it('records settings.whats_new.updated with the before/after config', async () => {
    service.getConfigHistory.mockResolvedValue([{ metadata: { timestamp: '2026-01-01T00:00:00.000Z' } }]);
    service.getConfig.mockResolvedValue({ model: 'a' });
    service.restoreFromHistory.mockResolvedValue({ model: 'b' });
    const { req, res } = createMocks({ method: 'POST', body: { index: 0 } });
    (req as any).user = { id: 'admin-1', isAdmin: true, username: 'root' };

    await handlers.restore.post(req, res);

    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'settings.whats_new.updated',
        changes: [{ field: 'config', before: { model: 'a' }, after: { model: 'b' } }],
      })
    );
  });
});
