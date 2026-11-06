import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  get: undefined as undefined | ((req: unknown, res: unknown) => Promise<void>),
  routeOptions: vi.fn(),
  buildVerdictEvalReport: vi.fn(),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: unknown) => {
    h.routeOptions(options);
    const chain = {
      use: () => chain,
      get: (fn: (req: unknown, res: unknown) => Promise<void>) => {
        h.get = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => vi.fn() }));
vi.mock('@server/security/verdictEval/loadVerdictEval', () => ({ buildVerdictEvalReport: h.buildVerdictEvalReport }));

const SINCE = new Date('2026-10-07T12:00:00.000Z');
const report = {
  since: SINCE,
  detections: 0,
  labelledDetections: 0,
  labelledAccounts: 0,
  scores: [],
  disagreements: [],
  truncated: false,
};

beforeEach(async () => {
  h.buildVerdictEvalReport.mockReset();
  await import('@pages/api/admin/shadow-detections/verdict-eval');
});

describe('GET /api/admin/shadow-detections/verdict-eval', () => {
  it('declares a jwt-only, admin-scoped route gated on support:read', () => {
    expect(h.routeOptions).toHaveBeenCalledWith({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
      adminPermissions: { GET: 'support:read' },
    });
  });

  it('grades the last 30 days by default, uncached', async () => {
    h.buildVerdictEvalReport.mockResolvedValue(report);
    const { req, res } = createMocks({ method: 'GET' });

    await h.get!(req, res);

    expect(h.buildVerdictEvalReport).toHaveBeenCalledWith(30);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(JSON.parse(res._getData())).toEqual({ ...report, since: SINCE.toISOString() });
  });

  it('takes a 7 or 90 day window', async () => {
    h.buildVerdictEvalReport.mockResolvedValue(report);
    const { req, res } = createMocks({ method: 'GET', query: { days: '90' } });

    await h.get!(req, res);

    expect(h.buildVerdictEvalReport).toHaveBeenCalledWith(90);
  });

  it('rejects another window', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { days: '365' } });

    await expect(h.get!(req, res)).rejects.toThrow('days must be 7, 30 or 90');
    expect(h.buildVerdictEvalReport).not.toHaveBeenCalled();
  });
});
