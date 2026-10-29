import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

const { handlers, baseOptions, listHeld } = vi.hoisted(() => ({
  handlers: {} as Record<string, (req: unknown, res: unknown) => Promise<void>>,
  baseOptions: vi.fn(),
  listHeld: vi.fn(),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => 'csrf' }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    baseOptions(options);
    const chain = {
      use: () => chain,
      get: (fn: typeof handlers.get) => {
        handlers.get = fn;
        return chain;
      },
      post: (fn: typeof handlers.post) => {
        handlers.post = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({ signupGrantReleaseRepository: { listHeld } }));
import '@pages/api/admin/held-signup-grants';

const run = async (query: Record<string, string>, isAdmin = true) => {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, { user: { id: 'admin-1', isAdmin }, logger: {} });
  await handlers
    .get(req, res)
    .catch((error: unknown) => (res.statusCode = (error as { statusCode?: number }).statusCode ?? 500));
  return res;
};
const row = (id: string) => ({ id, email: `${id}@example.test`, reason: 'budget_exhausted', createdAt: new Date(0) });

beforeEach(() => listHeld.mockReset().mockResolvedValue([]));

describe('GET /api/admin/held-signup-grants', () => {
  it('requires the admin scope on a JWT-only route', () => {
    expect(baseOptions).toHaveBeenCalledWith({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] });
  });
  it('rejects non-admins before querying', async () => {
    expect((await run({}, false)).statusCode).toBe(403);
    expect(listHeld).not.toHaveBeenCalled();
  });
  it('rejects an unknown reason and a malformed cursor', async () => {
    expect((await run({ reason: 'bogus' })).statusCode).toBe(400);
    expect((await run({ after: 'nope' })).statusCode).toBe(400);
    expect(listHeld).not.toHaveBeenCalled();
  });
  it('returns one page plus a cursor when more rows exist', async () => {
    listHeld.mockResolvedValue(Array.from({ length: 26 }, (_, n) => row(`${n}`.padStart(24, '0'))));
    const res = await run({ reason: 'budget_exhausted' });
    const body = res._getJSONData();
    expect(body.data).toHaveLength(25);
    expect(body.nextCursor).toBe(body.data[24].id);
    expect(listHeld).toHaveBeenCalledWith({ reason: 'budget_exhausted', afterId: undefined, limit: 26 });
  });
  it('returns no cursor on the last page', async () => {
    listHeld.mockResolvedValue([row('a'.repeat(24))]);
    expect((await run({}))._getJSONData().nextCursor).toBeNull();
  });
});
