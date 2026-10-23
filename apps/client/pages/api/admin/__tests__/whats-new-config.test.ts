// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  getCurrentConfig: vi.fn(),
  updateConfigWithHistory: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => routes[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (fn: (req: unknown, res: unknown) => unknown) => ((routes.GET = fn), chain),
        put: (fn: (req: unknown, res: unknown) => unknown) => ((routes.PUT = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@bike4mind/server-utils/services/whatsNewConfigService', () => ({
  WhatsNewConfigService: {
    getConfig: vi.fn(),
    getCurrentConfig: h.getCurrentConfig,
    updateConfigWithHistory: h.updateConfigWithHistory,
  },
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import handler from '../whats-new-config';

const put = async (body: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: 'PUT', body });
  (req as Record<string, unknown>).user = { id: 'admin-1', username: 'admin', isAdmin: true };
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.getCurrentConfig.mockResolvedValue({ modelId: 'gpt-4o-mini' });
  h.updateConfigWithHistory.mockResolvedValue(undefined);
  h.audit.mockResolvedValue(null);
});

describe('PUT /api/admin/whats-new-config admin audit', () => {
  it('records settings.whats_new.updated with the previous and saved config after the write', async () => {
    const { req, res } = await put({ modelId: 'gpt-4o' });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.whats_new.updated',
      target: { kind: 'settings', id: 'whats-new-config' },
      changes: [
        {
          field: 'config',
          before: { modelId: 'gpt-4o-mini' },
          after: expect.objectContaining({ modelId: 'gpt-4o' }),
        },
      ],
    });
    expect(h.updateConfigWithHistory.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('records before as null when no config was stored', async () => {
    h.getCurrentConfig.mockResolvedValue(null);

    await put({ modelId: 'gpt-4o' });

    expect(h.audit.mock.calls[0][1].changes[0].before).toBeNull();
  });

  it('records nothing for an invalid config', async () => {
    const { res } = await put({ temperature: 'hot' });

    expect(res._getStatusCode()).toBe(400);
    expect(h.updateConfigWithHistory).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });
});
