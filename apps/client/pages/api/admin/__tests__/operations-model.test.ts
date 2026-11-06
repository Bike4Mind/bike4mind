// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  stored: vi.fn(),
  update: vi.fn(),
  getModel: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => routes[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        get: (fn: (req: unknown, res: unknown) => unknown) => ((routes.GET = fn), chain),
        put: (fn: (req: unknown, res: unknown) => unknown) => ((routes.PUT = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  AdminSettings: { findOne: () => ({ lean: () => h.stored() }) },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: {
    updateOperationsModel: h.update,
    getOperationsModel: h.getModel,
    getOperationsModelConfig: vi.fn(),
  },
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import handler from '../operations-model';

const body = { modelId: 'gpt-4o', imageModelId: 'flux-pro', speechModelId: 'whisper-1' };

const put = async () => {
  const { req, res } = createMocks({ method: 'PUT', body });
  (req as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.stored.mockResolvedValue({
    settingValue: { modelId: 'gpt-4o-mini', imageModelId: 'flux-pro', speechModelId: 'whisper-1' },
  });
  h.update.mockResolvedValue(undefined);
  h.getModel.mockResolvedValue({ modelId: 'gpt-4o', modelInfo: { name: 'GPT-4o' } });
  h.audit.mockResolvedValue(null);
});

describe('PUT /api/admin/operations-model admin audit', () => {
  it('records a strict operationsModel entry with the per-key diff', async () => {
    const { req, res } = await put();

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.admin_settings.updated',
      target: { kind: 'settings', id: 'operationsModel' },
      changes: [{ field: 'operationsModel.modelId', before: 'gpt-4o-mini', after: 'gpt-4o' }],
    });
    expect(h.update.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('records before as null when nothing was stored', async () => {
    h.stored.mockResolvedValue(null);

    await put();

    expect(h.audit.mock.calls[0][1].changes).toEqual([{ field: 'operationsModel', before: null, after: body }]);
  });

  it('does not report success when the audit write rejects', async () => {
    h.audit.mockRejectedValue(new Error('audit down'));

    const { res } = await put();

    expect(res._getStatusCode()).toBe(500);
    expect(res._getJSONData()).not.toHaveProperty('success');
    expect(h.getModel).not.toHaveBeenCalled();
  });
});
