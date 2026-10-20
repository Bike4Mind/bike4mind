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
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: vi.fn().mockResolvedValue(null) }));
const repo = vi.hoisted(() => ({
  findByStageAndScanType: vi.fn(),
  updateById: vi.fn(),
  create: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({ securityScanScheduleRepository: repo }));
vi.mock('@bike4mind/server-utils/security/resolveStage', () => ({ resolveStage: () => 'dev' }));

import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

state.current = 'schedule';
await import('../[scanType]');

const post = (enabled: boolean) => {
  const { req, res } = createMocks({ method: 'POST', query: { scanType: 'web' }, body: { enabled } });
  (req as any).user = { id: 'admin-1', isAdmin: true };
  return { req, res };
};

describe('POST /api/admin/security-scan-schedule/[scanType] audit entries', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records settings.security_scan.disabled when an existing schedule is switched off', async () => {
    repo.findByStageAndScanType.mockResolvedValue({ id: 's1', enabled: true });
    const { req, res } = post(false);

    await handlers.schedule.post(req, res);

    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'settings.security_scan.disabled',
        target: expect.objectContaining({ kind: 'settings', id: 'security-scan-schedule:web' }),
        changes: [{ field: 'enabled', before: true, after: false }],
      })
    );
  });

  it('records settings.security_scan.enabled when an existing schedule is switched on', async () => {
    repo.findByStageAndScanType.mockResolvedValue({ id: 's1', enabled: false });
    const { req, res } = post(true);

    await handlers.schedule.post(req, res);

    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ action: 'settings.security_scan.enabled' })
    );
  });

  it('records settings.security_scan.enabled when a new schedule is created', async () => {
    repo.findByStageAndScanType.mockResolvedValue(null);
    const { req, res } = post(true);

    await handlers.schedule.post(req, res);

    expect(repo.create).toHaveBeenCalled();
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'settings.security_scan.enabled',
        details: expect.objectContaining({ newSchedule: true }),
      })
    );
  });
});
