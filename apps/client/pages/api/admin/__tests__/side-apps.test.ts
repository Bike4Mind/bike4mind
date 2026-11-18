import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const handlers: Record<string, (req: unknown, res: unknown) => Promise<unknown>> = {};
    const middlewares: ((req: unknown, res: unknown, next: () => void) => unknown)[] = [];
    const chain = async (req: { method: string }, res: unknown) => {
      for (const middleware of middlewares) await middleware(req, res, () => undefined);
      return handlers[req.method](req, res);
    };
    chain.use = (middleware: (typeof middlewares)[number]) => {
      middlewares.push(middleware);
      return chain;
    };
    chain.get = (fn: (typeof handlers)[string]) => {
      handlers.GET = fn;
      return chain;
    };
    chain._config = config;
    return chain;
  },
}));

const mockReadSideApps = vi.fn();
const mockReadSideAppUsers = vi.fn();
vi.mock('@server/admin/sideApps/readSideApps', () => ({ readSideApps: (...a: unknown[]) => mockReadSideApps(...a) }));
vi.mock('@server/admin/sideApps/readSideAppUsers', () => ({
  readSideAppUsers: (...a: unknown[]) => mockReadSideAppUsers(...a),
}));

import listHandler from '../side-apps/index';
import usersHandler from '../side-apps/[clientId]/users';

type TestUser = { id: string; isAdmin: boolean; adminPermissions?: string[] };

function call(handler: unknown, options: { user?: TestUser | null; query?: Record<string, string> }) {
  const { req, res } = createMocks({ method: 'GET', query: options.query ?? {} });
  if (options.user !== null) {
    (req as unknown as { user: TestUser }).user = options.user ?? { id: 'admin-1', isAdmin: true };
  }
  return { res, run: () => (handler as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res) };
}

describe.each([
  ['GET /api/admin/side-apps', listHandler, {}, () => mockReadSideApps],
  ['GET /api/admin/side-apps/[clientId]/users', usersHandler, { clientId: 'app-a' }, () => mockReadSideAppUsers],
] as const)('%s', (_name, handler, baseQuery, reader) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadSideApps.mockResolvedValue({ days: 30, apps: [] });
    mockReadSideAppUsers.mockResolvedValue({ clientId: 'app-a', users: [] });
  });

  it('accepts browser sessions only', () => {
    const config = (handler as unknown as { _config?: { auth?: unknown } })._config;
    expect(config?.auth).toBe('jwtOnly');
  });

  it('serves a full admin', async () => {
    const { res, run } = call(handler, { query: baseQuery });
    await run();
    expect(reader()).toHaveBeenCalledTimes(1);
    expect(res._getJSONData()).toBeTruthy();
  });

  it('serves a support:read delegate', async () => {
    const { run } = call(handler, {
      user: { id: 'support-1', isAdmin: false, adminPermissions: ['support:read'] },
      query: baseQuery,
    });
    await run();
    expect(reader()).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a delegate without support:read', { id: 'u', isAdmin: false, adminPermissions: ['billing:read'] }],
    ['a plain user', { id: 'u', isAdmin: false }],
    ['an unauthenticated request', null],
  ] as const)('refuses %s', async (_label, user) => {
    const { run } = call(handler, { user: user as TestUser | null, query: baseQuery });
    await expect(run()).rejects.toThrow(/missing permission/i);
    expect(reader()).not.toHaveBeenCalled();
  });

  it('defaults days to 30 and passes an explicit value through', async () => {
    await call(handler, { query: baseQuery }).run();
    await call(handler, { query: { ...baseQuery, days: '400' } }).run();
    const calls = reader().mock.calls;
    expect(calls[0].at(-1)).toBe(30);
    expect(calls[1].at(-1)).toBe(400);
  });
});

describe('GET /api/admin/side-apps/[clientId]/users', () => {
  it('passes the client id to the reader', async () => {
    mockReadSideAppUsers.mockResolvedValue({ users: [] });
    await call(usersHandler, { query: { clientId: 'app-z', days: '7' } }).run();
    expect(mockReadSideAppUsers).toHaveBeenCalledWith('app-z', 7);
  });
});
