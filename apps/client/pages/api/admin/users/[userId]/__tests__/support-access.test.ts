import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  guard: null as null | ((req: unknown, res: unknown, next: () => void) => void),
  find: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      use: (guard: unknown) => {
        h.guard ??= guard as typeof h.guard;
        return chain;
      },
      get: (fn: typeof h.handler) => {
        h.handler = fn;
        return chain;
      },
    };
    return chain;
  },
}));

vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ SupportAccess: { find: h.find } }));
vi.mock('@bike4mind/server-utils/auth/impersonation', () => ({
  customerSupportAccess: (row: { id: string }) => ({ id: row.id }),
}));

await import('../support-access');

const USER_ID = 'a'.repeat(24);
const makeReq = (user: Record<string, unknown>) => ({
  method: 'GET',
  query: { userId: USER_ID },
  user,
  headers: {},
  logger: { info: vi.fn(), error: vi.fn() },
});

// Runs the permission guard adminApi installs, then the handler, as the router would.
const guarded = async (req: ReturnType<typeof makeReq>) => {
  h.guard!(req, {}, () => {});
  const json = vi.fn();
  await h.handler!(req, { json });
  return json;
};
const delegate = (adminPermissions: string[]) => ({ id: 'd-1', username: 'd', isAdmin: false, adminPermissions });

describe('GET /api/admin/users/[userId]/support-access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const chain = {
      select: () => chain,
      sort: () => chain,
      limit: () => chain,
      maxTimeMS: async () => [{ id: 'row-1', adminId: 'x', reason: 'why', escalatedAt: null }],
    };
    h.find.mockReturnValue(chain);
  });

  it('rejects a delegate without users:impersonate', async () => {
    await expect(guarded(makeReq(delegate(['support:read'])))).rejects.toThrow(/Missing permission: users:impersonate/);
    expect(h.find).not.toHaveBeenCalled();
  });

  it('returns the rows to a delegate with users:impersonate', async () => {
    const json = await guarded(makeReq(delegate(['users:impersonate'])));
    expect(json).toHaveBeenCalledWith({ items: [expect.objectContaining({ id: 'row-1', reason: 'why' })] });
  });

  it('returns the rows to a full admin', async () => {
    const json = await guarded(makeReq({ id: 'a-1', username: 'a', isAdmin: true }));
    expect(json).toHaveBeenCalledTimes(1);
  });
});
