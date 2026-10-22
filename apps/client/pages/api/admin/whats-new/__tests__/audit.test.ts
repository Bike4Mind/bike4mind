import { describe, it, expect, vi, beforeEach } from 'vitest';
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

const mocks = vi.hoisted(() => ({
  getWhatsNewEnvInfo: vi.fn(),
  fetchAndImportLatest: vi.fn(),
  syncExistingModals: vi.fn(),
  importModalByKey: vi.fn(),
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
}));
vi.mock('@server/utils/whatsNewEnv', () => ({ getWhatsNewEnvInfo: mocks.getWhatsNewEnvInfo }));
vi.mock('@server/services/whatsNewForkFetcher', () => ({
  WhatsNewForkFetcher: {
    fetchAndImportLatest: mocks.fetchAndImportLatest,
    syncExistingModals: mocks.syncExistingModals,
    importModalByKey: mocks.importModalByKey,
  },
  validateDistributionUrl: () => ({ valid: true }),
}));
vi.mock('@bike4mind/database', () => ({
  AdminSettings: { findOne: mocks.findOne, findOneAndUpdate: mocks.findOneAndUpdate },
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: vi.fn().mockResolvedValue(null) }));

import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

state.current = 'config';
await import('../config');
state.current = 'sync';
await import('../sync');
state.current = 'import';
await import('../import');

const adminReq = (method: 'PUT' | 'POST', body: unknown = {}) => {
  const { req, res } = createMocks({ method, body: body as object });
  (req as any).user = { id: 'admin-1', isAdmin: true };
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getWhatsNewEnvInfo.mockResolvedValue({
    stage: 'dev',
    isSourceEnvironment: false,
    isForkProduction: false,
    distributionUrlConfigured: true,
  });
});

describe("What's New admin audit entries", () => {
  it('PUT config records settings.whats_new.updated with the config diff', async () => {
    mocks.findOne.mockResolvedValue(null);
    mocks.findOneAndUpdate.mockResolvedValue({});
    const { req, res } = adminReq('PUT', { autoSyncEnabled: true });

    await handlers.config.put(req, res);

    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'settings.whats_new.updated',
        target: expect.objectContaining({ kind: 'settings' }),
        changes: [expect.objectContaining({ field: 'syncConfig' })],
      })
    );
  });

  it('POST sync records settings.whats_new.synced', async () => {
    mocks.fetchAndImportLatest.mockResolvedValue({ imported: false, reason: 'up to date' });
    mocks.syncExistingModals.mockResolvedValue({ updated: 0, deleted: 0, upToDate: 1, errors: [] });
    const { req, res } = adminReq('POST');

    await handlers.sync.post(req, res);

    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ action: 'settings.whats_new.synced' })
    );
  });

  it('POST import records settings.whats_new.synced with the imported keys', async () => {
    mocks.importModalByKey.mockResolvedValue({ success: true });
    const { req, res } = adminReq('POST', { modalKeys: ['production/2026-01-01.json'] });

    await handlers.import.post(req, res);

    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'settings.whats_new.synced',
        details: expect.objectContaining({ modalKeys: ['production/2026-01-01.json'] }),
      })
    );
  });
});
