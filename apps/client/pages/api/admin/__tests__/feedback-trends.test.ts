import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockCompute } = vi.hoisted(() => ({ mockCompute: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const chain = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) middleware(req, res, () => undefined);
        return h[(req as { method?: string }).method ?? 'GET']?.(req, res);
      },
      {
        use: (fn: (req: unknown, res: unknown, next: () => void) => void) => (middlewares.push(fn), chain),
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
        _config: config,
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/admin/feedbackTrends', () => ({ computeFeedbackTrends: mockCompute }));

import handler from '../feedback-trends';

const call = (user: unknown) => {
  const { req, res } = createMocks({ method: 'GET' });
  (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const configOf = () => (handler as unknown as { _config?: { auth?: unknown; requiredScopes?: string[] } })._config;

beforeEach(() => {
  mockCompute.mockReset().mockResolvedValue({ open: 3 });
});

describe('GET /api/admin/feedback-trends', () => {
  it('refuses API keys: jwtOnly and no requiredScopes', () => {
    expect(configOf()?.auth).toBe('jwtOnly');
    expect(configOf()?.requiredScopes).toBeUndefined();
  });

  it('rejects a support:read delegate who is not a full admin, like the Feedback tab', async () => {
    await expect(
      call({ id: 'delegate', isAdmin: false, adminPermissions: ['support:read'] }).promise
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mockCompute).not.toHaveBeenCalled();
  });

  it('rejects a caller without support read access before computing', async () => {
    await expect(call({ id: 'reader', isAdmin: false, adminPermissions: [] }).promise).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mockCompute).not.toHaveBeenCalled();
  });

  it('propagates a failed aggregate rather than returning empty trends', async () => {
    mockCompute.mockRejectedValue(new Error('aggregate failed'));
    await expect(call({ id: 'admin', isAdmin: true }).promise).rejects.toThrow('aggregate failed');
  });

  it('returns the trends to a full admin, uncached', async () => {
    const { res, promise } = call({ id: 'admin', isAdmin: true });
    await promise;

    expect(res._getJSONData()).toEqual({ open: 3 });
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });
});
