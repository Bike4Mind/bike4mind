import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { search, audit, rateOptions } = vi.hoisted(() => ({
  search: vi.fn(),
  audit: vi.fn(),
  rateOptions: [] as unknown[],
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    const middleware: ((req: unknown, res: unknown, next: () => void) => void)[] = [];
    const route = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const guard of middleware) await guard(req, res, () => undefined);
        return route.handler(req, res);
      },
      {
        handler: (_req: unknown, _res: unknown): unknown => undefined,
        use: (guard: (req: unknown, res: unknown, next: () => void) => void) => {
          middleware.push(guard);
          return route;
        },
        get: (handler: (req: unknown, res: unknown) => unknown) => {
          route.handler = handler;
          return route;
        },
        options,
      }
    );
    return route;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => {
    rateOptions.push(options);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
vi.mock('@server/admin/search/searchEntities', () => ({ searchAdminEntities: search }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: audit }));
import handler from '../search';

async function call(q: unknown, user: unknown = { id: 'admin', isAdmin: true }, method = 'GET') {
  const { req, res } = createMocks({ method, query: { q } });
  Object.assign(req, { user });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  search.mockResolvedValue([]);
  audit.mockResolvedValue({});
});

describe('admin search route', () => {
  it.each([undefined, { id: 'user', isAdmin: false }, { id: 'delegate', adminPermissions: ['support:read'] }])(
    'rejects callers without full admin access',
    async user => {
      await expect(call('test@example.com', user ?? null)).rejects.toThrow();
      expect(search).not.toHaveBeenCalled();
    }
  );
  it('requires JWT auth, enforces methods and a fixed search rate bucket', async () => {
    expect((handler as unknown as { options: unknown }).options).toMatchObject({
      auth: 'jwtOnly',
      allowedMethods: ['GET'],
    });
    expect(rateOptions).toContainEqual({ limit: 30, windowMs: 60_000, bucket: 'admin-entity-search' });
    await expect(call('Example', undefined, 'POST')).rejects.toThrow();
  });
  it('validates before lookup and returns uncached results', async () => {
    await expect(call(['one', 'two'])).rejects.toThrow();
    await expect(call('b4m_live_' + 'a'.repeat(32))).rejects.toThrow();
    expect(search).not.toHaveBeenCalled();
    const res = await call('  test@example.com  ');
    expect(search).toHaveBeenCalledWith('test@example.com');
    expect(res.getHeader('Cache-Control')).toBe('no-store');
    expect(res._getJSONData()).toEqual({ results: [] });
    expect(audit).not.toHaveBeenCalled();
  });
  it.each(['192.0.2.1', 'b4m_live_abcd'])('audits %s without recording the identifier', async q => {
    await call(q);
    expect(audit).toHaveBeenCalledOnce();
    expect(JSON.stringify(audit.mock.calls[0][1])).not.toContain(q);
    expect(audit.mock.invocationCallOrder[0]).toBeLessThan(search.mock.invocationCallOrder[0]);
  });
  it('does not search when sensitive-search audit fails', async () => {
    audit.mockRejectedValue(new Error('Audit unavailable'));
    await expect(call('192.0.2.1')).rejects.toThrow('Audit unavailable');
    expect(search).not.toHaveBeenCalled();
  });
});
