import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const routes = vi.hoisted(() => ({}) as Record<string, Handler>);
const routeAuth = vi.hoisted(() => [] as unknown[]);
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: { auth?: unknown } = {}) => {
    routeAuth.push(options.auth);
    const chain: Record<string, unknown> = { use: () => chain };
    for (const method of ['get', 'post', 'patch']) {
      chain[method] = (fn: Handler) => {
        routes[method] = fn;
        return chain;
      };
    }
    return chain;
  },
}));
const writes = vi.hoisted(() => ({
  patchModelAccess: vi.fn(async () => ({ entry: null, changed: false, revision: null })),
  dryRunModelAccessBulk: vi.fn(async () => ({})),
}));
vi.mock('@server/admin/models/adminModelFilter', () => ({ resolveAdminModelFilterIds: vi.fn() }));
vi.mock('@server/modelAccess/modelAccess', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/modelAccess/modelAccess')>()),
  ...writes,
}));
const aggregate = vi.hoisted(() =>
  vi.fn(() => {
    const pipeline = { option: () => pipeline, read: async () => [] };
    return pipeline;
  })
);
vi.mock('@bike4mind/database', () => ({ User: { aggregate }, cacheRepository: {} }));
vi.mock('@bike4mind/services', () => ({
  cacheService: { getCachedData: (_key: string, load: () => Promise<unknown>) => load() },
}));

await import('../index');
const patchRoute = routes.patch;
await import('../bulk');
const bulkRoute = routes.post;
await import('../../../users/tags');
const tagsRoute = routes.get;

const DELEGATE = { id: 'd1', isAdmin: false, adminPermissions: ['settings:manage'] };
const ADMIN = { id: 'a1', isAdmin: true, adminPermissions: [] };
const res = () => ({ json: vi.fn() });
const patchReq = (user: unknown) => ({
  user,
  query: { id: 'model-a' },
  body: { change: { enabled: false }, reason: 'turning it off', expectedUpdatedAt: null },
});
const bulkReq = (user: unknown) => ({ user, body: { selection: { ids: ['model-a'] }, change: { enabled: false } } });

describe('model access endpoints need a full admin', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accept session JWTs only, never an API key', () => {
    expect(routeAuth).toEqual(['jwtOnly', 'jwtOnly', 'jwtOnly']);
  });

  it('refuses a settings:manage delegate with 403 before any read or write', async () => {
    await expect(patchRoute(patchReq(DELEGATE), res())).rejects.toMatchObject({ statusCode: 403 });
    await expect(bulkRoute(bulkReq(DELEGATE), res())).rejects.toMatchObject({ statusCode: 403 });
    await expect(tagsRoute({ user: DELEGATE }, res())).rejects.toMatchObject({ statusCode: 403 });
    expect(writes.patchModelAccess).not.toHaveBeenCalled();
    expect(writes.dryRunModelAccessBulk).not.toHaveBeenCalled();
    expect(aggregate).not.toHaveBeenCalled();
  });

  it('lets a full admin through', async () => {
    await patchRoute(patchReq(ADMIN), res());
    await bulkRoute(bulkReq(ADMIN), res());
    await tagsRoute({ user: ADMIN }, res());
    expect(writes.patchModelAccess).toHaveBeenCalledOnce();
    expect(writes.dryRunModelAccessBulk).toHaveBeenCalledOnce();
    expect(aggregate).toHaveBeenCalledOnce();
  });
});
