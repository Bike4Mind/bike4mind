import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { handlers, packages, invites } = vi.hoisted(() => ({
  handlers: {} as Record<string, (req: unknown, res: unknown) => unknown>,
  packages: { findById: vi.fn() },
  invites: { listByGrantPackage: vi.fn() },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const chain: Record<string, unknown> = {
      use: (middleware: (req: unknown, res: unknown, next: () => void) => void) => {
        middlewares.push(middleware);
        return chain;
      },
    };
    for (const method of ['get', 'post', 'patch']) {
      chain[method] = (fn: (req: unknown, res: unknown) => unknown) => {
        handlers[method] = async (req: unknown, res: unknown) => {
          for (const middleware of middlewares) middleware(req, res, () => undefined);
          return fn(req, res);
        };
        return chain;
      };
    }
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  grantPackageRepository: packages,
  registrationInviteRepository: invites,
}));

import '@pages/api/admin/grant-packages/[id]/links';

const PKG = 'a'.repeat(24);

async function get(query: Record<string, unknown>, user: unknown = { isAdmin: true, id: 'admin-1' }) {
  const { req, res } = createMocks({ method: 'GET' });
  Object.assign(req, { user, query });
  try {
    await handlers.get(req, res);
  } catch (error) {
    res.statusCode = (error as { statusCode?: number }).statusCode ?? 500;
  }
  return res;
}

describe('GET /api/admin/grant-packages/[id]/links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    packages.findById.mockResolvedValue({ id: PKG, name: 'Launch' });
    invites.listByGrantPackage.mockResolvedValue({ data: [], truncated: false });
  });

  it.each([
    ['missing', undefined],
    ['malformed', 'not-an-id'],
    ['an array', [PKG]],
  ])('rejects a %s id with 400', async (_label, id) => {
    expect((await get({ id })).statusCode).toBe(400);
    expect(packages.findById).not.toHaveBeenCalled();
  });

  it('rejects a non-admin with 403 and reads nothing', async () => {
    expect((await get({ id: PKG }, { isAdmin: false, id: 'u1' })).statusCode).toBe(403);
    expect(packages.findById).not.toHaveBeenCalled();
    expect(invites.listByGrantPackage).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown package', async () => {
    packages.findById.mockResolvedValue(null);
    expect((await get({ id: PKG })).statusCode).toBe(404);
    expect(invites.listByGrantPackage).not.toHaveBeenCalled();
  });

  it('returns empty link lists for a package with nothing linked', async () => {
    const res = await get({ id: PKG });
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      invites: { data: [], truncated: false },
      partnerRules: { data: [], truncated: false },
    });
  });

  it('lists the linked codes capped at 50 and passes the truncated flag through', async () => {
    invites.listByGrantPackage.mockResolvedValue({ data: [{ id: 'i1', code: 'ABC' }], truncated: true });
    const res = await get({ id: PKG });
    expect(invites.listByGrantPackage).toHaveBeenCalledWith(PKG, 50);
    expect(res._getJSONData().invites).toEqual({ data: [{ id: 'i1', code: 'ABC' }], truncated: true });
  });
});
