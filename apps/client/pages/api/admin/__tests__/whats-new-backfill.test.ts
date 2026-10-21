// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  adminFindOne: vi.fn(),
  adminFindOneAndUpdate: vi.fn(),
  modalFindOne: vi.fn(),
  collect: vi.fn(),
  sendToQueue: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => routes[(req as { method?: string }).method ?? 'POST']?.(req, res),
      {
        use: () => chain,
        post: (fn: (req: unknown, res: unknown) => unknown) => ((routes.POST = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@bike4mind/database', () => ({
  AdminSettings: { findOne: h.adminFindOne, findOneAndUpdate: h.adminFindOneAndUpdate },
  ModalModel: { findOne: h.modalFindOne },
}));
vi.mock('@server/services/whatsNewDataCollector', () => ({ collectDataForDate: h.collect }));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({ getSourceQueueUrl: () => 'https://queue' }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'dev' } } }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import handler from '../whats-new-backfill';

const post = async (body: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.adminFindOne.mockResolvedValue(null);
  h.adminFindOneAndUpdate.mockResolvedValue({});
  h.modalFindOne.mockResolvedValue(null);
  h.collect.mockResolvedValue({ filteredPRCount: 2, rawPRCount: 3, payload: {} });
  h.sendToQueue.mockResolvedValue(undefined);
  h.audit.mockResolvedValue(null);
});

describe('POST /api/admin/whats-new-backfill admin audit', () => {
  it('records settings.whats_new.generation_triggered with the backfill job and outcome counts', async () => {
    const { req, res } = await post({ dates: ['2026-10-02', '2026-10-01'] });

    expect(res._getStatusCode()).toBe(200);
    expect(h.sendToQueue).toHaveBeenCalledTimes(2);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.whats_new.generation_triggered',
      target: { kind: 'settings', id: 'whatsNewBackfill' },
      details: {
        job: 'backfill',
        dryRun: false,
        dates: ['2026-10-01', '2026-10-02'],
        queued: 2,
        skipped: 0,
        noPRs: 0,
        failed: 0,
      },
    });
  });

  it('flags a dry run in the entry and dispatches nothing', async () => {
    await post({ dates: ['2026-10-01'], dryRun: true });

    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(h.audit.mock.calls[0][1].details).toMatchObject({ job: 'backfill', dryRun: true, queued: 1 });
  });

  it('counts skipped dates', async () => {
    h.modalFindOne.mockResolvedValue({ id: 'existing' });

    await post({ dates: ['2026-10-01'] });

    expect(h.audit.mock.calls[0][1].details).toMatchObject({ queued: 0, skipped: 1 });
  });

  it('records nothing for an invalid request', async () => {
    const { res } = await post({ dates: ['not-a-date'] });

    expect(res._getStatusCode()).toBe(400);
    expect(h.audit).not.toHaveBeenCalled();
  });
});
