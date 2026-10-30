// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  audit: vi.fn(),
  loadConfig: vi.fn(),
  sendReport: vi.fn(),
}));

vi.mock('@client/server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.post = (handler: unknown) => handler;
    return chain;
  },
}));
vi.mock('@server/services/prReport/context', () => ({
  loadPrReportConfig: h.loadConfig,
  createSendDeps: () => ({}),
}));
vi.mock('@bike4mind/services', () => ({ prReportService: { sendReport: h.sendReport } }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import handler from '../send';

const run = async (text = 'weekly report body') => {
  const { req, res } = createMocks({ method: 'POST', body: { text } });
  (req as unknown as { user: unknown }).user = { id: 'admin-1', email: 'a@example.com', isAdmin: true };
  (req as unknown as { logger: unknown }).logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
  h.loadConfig.mockResolvedValue({ repo: 'owner/repo', destination: 'https://hooks.example.test/x' });
});

describe('POST /api/admin/pr-report/send', () => {
  it('records support.pr_report.sent when a post was made, never the text', async () => {
    h.sendReport.mockResolvedValue({ ok: true, response: { outcome: 'sent' } });

    const { req, res } = await run();

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    const input = h.audit.mock.calls[0][1];
    expect(input).toMatchObject({
      action: 'support.pr_report.sent',
      target: { kind: 'system', id: 'pr_report' },
      details: { repo: 'owner/repo' },
    });
    expect(JSON.stringify(input)).not.toContain('weekly report body');
    expect(JSON.stringify(input)).not.toContain('hooks.example.test');
    expect(h.sendReport.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it.each(['deduped', 'deliveryUnknown'])('records nothing for a %s outcome', async outcome => {
    h.sendReport.mockResolvedValue({ ok: true, response: { outcome } });

    const { res } = await run();

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('records nothing when delivery failed', async () => {
    h.sendReport.mockResolvedValue({ ok: false, failure: { kind: 'notDelivered' } });

    const { res } = await run();

    expect(res._getStatusCode()).toBe(502);
    expect(h.audit).not.toHaveBeenCalled();
  });
});
