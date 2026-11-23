// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const baseApiOptions = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    baseApiOptions.value = options;
    const middlewares: ((req: unknown, res: unknown, next: () => void) => unknown)[] = [];
    const chain = {
      use: (middleware: (req: unknown, res: unknown, next: () => void) => unknown) => {
        middlewares.push(middleware);
        return chain;
      },
      get: (handler: (req: unknown, res: unknown) => Promise<unknown>) => async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) await middleware(req, res, () => {});
        return handler(req, res);
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));

const mockFindById = vi.fn();
const mockFindServiceAccount = vi.fn();
vi.mock('@bike4mind/database', () => ({
  organizationRepository: { findById: (...args: unknown[]) => mockFindById(...args) },
}));
vi.mock('@server/organizations/orgApiKeys', () => ({
  findServiceAccount: (...args: unknown[]) => mockFindServiceAccount(...args),
}));

import handler from '../service-account';

type HandlerFn = (req: unknown, res: unknown) => Promise<unknown>;

const call = async (
  user: Record<string, unknown> = { id: 'admin-1', isAdmin: true },
  id: string | undefined = 'org-1'
) => {
  const { req, res } = createMocks({ method: 'GET', query: id ? { id } : {} });
  Object.assign(req, { user });
  await (handler as HandlerFn)(req, res);
  return res;
};

describe('GET /api/admin/organizations/[id]/service-account', () => {
  it('declares first-party JWT-only authentication and only GET', () => {
    expect(baseApiOptions.value).toMatchObject({ auth: 'jwtOnly', allowedMethods: ['GET'] });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue({ id: 'org-1', name: 'Acme' });
    mockFindServiceAccount.mockResolvedValue({ id: 'svc-1' });
  });

  it('refuses a delegate without support:read', async () => {
    await expect(call({ id: 'delegate', isAdmin: false, adminPermissions: ['keys:revoke'] })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mockFindServiceAccount).not.toHaveBeenCalled();
  });

  it('returns the service account id for an organization that has one', async () => {
    const res = await call();
    expect(mockFindServiceAccount).toHaveBeenCalledWith('org-1');
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ serviceAccountId: 'svc-1' });
  });

  it('returns null when no service account exists yet', async () => {
    mockFindServiceAccount.mockResolvedValue(null);
    const res = await call();
    expect(res._getJSONData()).toEqual({ serviceAccountId: null });
  });

  it('404s for an unknown organization without looking up the account', async () => {
    mockFindById.mockResolvedValue(null);
    await expect(call()).rejects.toMatchObject({ statusCode: 404 });
    expect(mockFindServiceAccount).not.toHaveBeenCalled();
  });

  it('400s without an organization id', async () => {
    await expect(call(undefined, '')).rejects.toMatchObject({ statusCode: 400 });
  });
});
