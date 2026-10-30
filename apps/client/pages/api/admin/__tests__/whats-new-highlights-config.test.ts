// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
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
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@bike4mind/database', () => ({
  AdminSettings: { findOne: h.findOne, findOneAndUpdate: h.findOneAndUpdate },
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import handler from '../whats-new-highlights-config';

const put = async (body: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: 'PUT', body });
  (req as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.findOne.mockResolvedValue({
    settingValue: { enabled: false, llmModel: 'gpt-4o-mini', lastRunAt: '2026-10-01T00:00:00.000Z' },
  });
  h.findOneAndUpdate.mockResolvedValue({});
  h.audit.mockResolvedValue(null);
});

describe('PUT /api/admin/whats-new-highlights-config admin audit', () => {
  it('records settings.whats_new.updated with only the admin-editable keys that changed', async () => {
    const { req, res } = await put({ enabled: false, llmModel: 'gpt-4o' });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.whats_new.updated',
      target: { kind: 'settings', id: 'whatsNewHighlightsConfig' },
      changes: [{ field: 'highlightsConfig.llmModel', before: 'gpt-4o-mini', after: 'gpt-4o' }],
    });
    // Bookkeeping fields such as lastRunAt never reach the entry.
    expect(JSON.stringify(h.audit.mock.calls[0][1])).not.toContain('lastRunAt');
    expect(h.findOneAndUpdate.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('records a newly set key as changing from undefined', async () => {
    h.findOne.mockResolvedValue(null);

    await put({ enabled: false });

    expect(h.audit.mock.calls[0][1].changes).toEqual([
      { field: 'highlightsConfig.enabled', before: undefined, after: false },
    ]);
  });

  it('records nothing when validation refuses the config', async () => {
    const { res } = await put({ enabled: true });

    expect(res._getStatusCode()).toBe(400);
    expect(h.findOneAndUpdate).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });
});
