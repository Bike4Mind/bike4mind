// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({ audit: vi.fn(), findById: vi.fn(), update: vi.fn() }));

type Route = (req: unknown, res: unknown) => unknown;

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, Route> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => routes[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        patch: (fn: Route) => ((routes.PATCH = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: Route) => fn }));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@bike4mind/database', () => ({
  sreErrorPatternRepository: { findById: h.findById, update: h.update },
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import handler from '../[id]';

const PATTERN_ID = '507f1f77bcf86cd799439011';

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
  h.findById.mockResolvedValue({
    id: PATTERN_ID,
    isActive: false,
    workaroundIneffective: true,
    rootCauseTrackingIssue: null,
  });
  h.update.mockResolvedValue({
    id: PATTERN_ID,
    name: 'Timeout pattern',
    isActive: true,
    workaroundIneffective: true,
    rootCauseTrackingIssue: null,
  });
});

describe('PATCH /api/sre/patterns/[id] admin audit', () => {
  it('records ops.sre.pattern_updated with only the changed fields', async () => {
    const { req, res } = createMocks({ method: 'PATCH', query: { id: PATTERN_ID }, body: { isActive: true } });
    (req as unknown as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };

    await (handler as unknown as Route)(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'ops.sre.pattern_updated',
      target: { kind: 'settings', id: PATTERN_ID, displayName: 'Timeout pattern' },
      changes: [{ field: 'isActive', before: false, after: true }],
    });
    expect(h.update.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('skips the entry when the PATCH changes nothing', async () => {
    h.findById.mockResolvedValue({ id: PATTERN_ID, isActive: true, workaroundIneffective: false });
    h.update.mockResolvedValue({
      id: PATTERN_ID,
      isActive: true,
      workaroundIneffective: false,
      rootCauseTrackingIssue: null,
    });
    const { req, res } = createMocks({
      method: 'PATCH',
      query: { id: PATTERN_ID },
      body: { isActive: true, rootCauseTrackingIssue: null },
    });
    (req as unknown as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };

    await (handler as unknown as Route)(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).not.toHaveBeenCalled();
  });
});
