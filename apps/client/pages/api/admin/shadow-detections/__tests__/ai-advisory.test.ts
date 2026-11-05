import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  get: undefined as undefined | ((req: unknown, res: unknown) => Promise<void>),
  routeOptions: vi.fn(),
  listAiAbuseAdvisories: vi.fn(),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
// The permission gate itself is adminApi's (covered by its own tests); this asserts the route declares it.
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
vi.mock('@server/admin/aiAdvisory/aiAbuseAdvisories', () => ({ listAiAbuseAdvisories: h.listAiAbuseAdvisories }));

const SINCE = new Date('2026-11-04T12:00:00.000Z');

beforeEach(async () => {
  h.listAiAbuseAdvisories.mockReset();
  await import('@pages/api/admin/shadow-detections/ai-advisory');
});

describe('GET /api/admin/shadow-detections/ai-advisory', () => {
  it('declares a jwt-only, admin-scoped route gated on support:read', () => {
    expect(h.routeOptions).toHaveBeenCalledWith({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
      adminPermissions: { GET: 'support:read' },
    });
  });

  it('returns the advisory summary uncached', async () => {
    const summary = { since: SINCE, advisories: [], networks: [], mailDomains: [], truncated: false };
    h.listAiAbuseAdvisories.mockResolvedValue(summary);
    const { req, res } = createMocks({ method: 'GET' });

    await h.get!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(JSON.parse(res._getData())).toEqual({ ...summary, since: SINCE.toISOString() });
  });

  it('lets a helper failure propagate to the error middleware', async () => {
    h.listAiAbuseAdvisories.mockRejectedValue(new Error('db down'));
    const { req, res } = createMocks({ method: 'GET' });

    await expect(h.get!(req, res)).rejects.toThrow('db down');
  });
});
