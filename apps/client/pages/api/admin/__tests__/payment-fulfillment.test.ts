import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const guards: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const chain = Object.assign(
      (req: { method?: string }, res: unknown) => {
        for (const guard of guards) guard(req, res, () => {});
        return handlers[req.method ?? 'GET']?.(req, res);
      },
      {
        use: (fn: (req: unknown, res: unknown, next: () => void) => void) => (guards.push(fn), chain),
        get: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.GET = fn), chain),
        _config: config,
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@server/admin/paymentFulfillment/read', () => ({ readPaymentFulfillment: mocks.read }));
import handler from '../payment-fulfillment';

const ADMIN = { id: 'a'.repeat(24), isAdmin: true };
const logger = { error: vi.fn() };
async function call(query: Record<string, string> = {}, user: Record<string, unknown> = ADMIN) {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, { user, logger });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({ availability: 'unavailable', items: [] });
});

describe('payment fulfillment endpoint', () => {
  it('is JWT-only and read-only', () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({ auth: 'jwtOnly', allowedMethods: ['GET'] });
  });
  it('denies non-admins before reading provider evidence', async () => {
    await expect(call({}, { id: ADMIN.id, isAdmin: false })).rejects.toThrow('Missing permission: support:read');
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('admits delegated readers and disables response caching', async () => {
    const res = await call({}, { id: ADMIN.id, isAdmin: false, adminPermissions: ['support:read'] });
    expect(res._getJSONData()).toMatchObject({ availability: 'unavailable' });
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(mocks.read).toHaveBeenCalledWith({ days: 7, limit: 10 }, logger);
  });
  it('rejects malformed or unbounded input before provider calls', async () => {
    for (const query of [{ days: '999' }, { limit: '100' }, { state: 'nonsense' }, { cursor: 'abc' }]) {
      await expect(call(query)).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
