import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { handlers, repo, audit } = vi.hoisted(() => ({
  handlers: {} as Record<string, (req: unknown, res: unknown) => unknown>,
  repo: { listPackages: vi.fn(), create: vi.fn(), findById: vi.fn(), updatePackage: vi.fn() },
  audit: vi.fn(),
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
  grantPackageRepository: repo,
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
// Keep parseAdminActionReason real so the 400 is the production one.
vi.mock('@server/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/utils/adminAudit')>()),
  recordAdminActionFromRequest: audit,
  loadCreditGrantPolicy: async () => ({
    singleGrantCredits: 50_000,
    dailyTotalCredits: 200_000,
    sumCreditsGranted: async () => 0,
  }),
}));

import '@pages/api/admin/grant-packages/index';
import '@pages/api/admin/grant-packages/[id]';

function makeReqRes(method: string, over: { user?: unknown; body?: unknown; query?: unknown } = {}) {
  const { req, res } = createMocks({ method });
  (req as { user?: unknown }).user = 'user' in over ? over.user : { isAdmin: true, id: 'admin-1' };
  (req as { body?: unknown }).body = over.body ?? {};
  (req as { query?: unknown }).query = over.query ?? {};
  return { req, res };
}

const small = { name: 'Launch', credits: 100, totalCap: 1, dailyCap: null };

describe('/api/admin/grant-packages (POST)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repo.create.mockImplementation(async input => ({ id: 'p1', redeemedTotal: 0, capHits: 0, active: true, ...input }));
  });

  it('rejects a non-admin with 403 and never writes', async () => {
    const { req, res } = makeReqRes('POST', { user: { isAdmin: false }, body: small });
    await expect(handlers.post(req, res)).rejects.toThrow(/missing permission/i);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects a daily cap above the total cap and never writes', async () => {
    const { req, res } = makeReqRes('POST', { body: { ...small, totalCap: 5, dailyCap: 6 } });
    await expect(handlers.post(req, res)).rejects.toThrow(/dailyCap: must not exceed totalCap/);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('creates a package under the threshold without a reason and audits it', async () => {
    const { req, res } = makeReqRes('POST', { body: small });
    await handlers.post(req, res);
    expect(res._getStatusCode()).toBe(201);
    expect(repo.create).toHaveBeenCalledWith({ ...small, createdBy: 'admin-1', reason: null });
    expect(audit).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ action: 'credits.grant_package.created', reason: undefined })
    );
  });

  it('refuses a large package without a reason', async () => {
    const { req, res } = makeReqRes('POST', { body: { ...small, credits: 60_000 } });
    await expect(handlers.post(req, res)).rejects.toThrow(/outdated version/i);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('refuses an uncapped package with credits when the reason is too short', async () => {
    const { req, res } = makeReqRes('POST', { body: { ...small, totalCap: null, reason: 'x' } });
    await expect(handlers.post(req, res)).rejects.toThrow(/at least 5 characters/i);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('creates a large package with a reason, storing and auditing it', async () => {
    const { req, res } = makeReqRes('POST', { body: { ...small, totalCap: null, reason: 'Pilot or partner access' } });
    await handlers.post(req, res);
    expect(res._getStatusCode()).toBe(201);
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ reason: 'Pilot or partner access' }));
    expect(audit).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        reason: 'Pilot or partner access',
        details: expect.objectContaining({ reasonRequired: true }),
      })
    );
  });

  it.each([0, '', 'ten', 2.5])('rejects totalCap %j with a 400', async cap => {
    const { req, res } = makeReqRes('POST', { body: { ...small, totalCap: cap } });
    await expect(handlers.post(req, res)).rejects.toThrow(/totalCap/);
    expect(repo.create).not.toHaveBeenCalled();
  });
});

describe('/api/admin/grant-packages (GET)', () => {
  it('returns the page with the live reason thresholds', async () => {
    repo.listPackages.mockResolvedValue({ data: [], meta: { currentPage: 1, totalPages: 0, total: 0 } });
    const { req, res } = makeReqRes('GET', { query: { page: '2' } });
    await handlers.get(req, res);
    expect(repo.listPackages).toHaveBeenCalledWith({ page: 2, limit: 25 });
    expect(res._getJSONData().reasonPolicy).toEqual({ singleGrantCredits: 50_000, dailyTotalCredits: 200_000 });
  });
});

describe('/api/admin/grant-packages/[id] (PATCH)', () => {
  const stored = { id: 'p1', ...small, redeemedTotal: 1, capHits: 0, active: true, createdBy: 'admin-1' };

  beforeEach(() => {
    vi.clearAllMocks();
    repo.findById.mockResolvedValue(stored);
    repo.updatePackage.mockImplementation(async (_id, patch) => ({ ...stored, ...patch }));
  });

  it('requires a reason to remove the cap', async () => {
    const { req, res } = makeReqRes('PATCH', { query: { id: 'p1' }, body: { totalCap: null } });
    await expect(handlers.patch(req, res)).rejects.toThrow(/outdated version/i);
    expect(repo.updatePackage).not.toHaveBeenCalled();
  });

  it('removes the cap with a reason and audits the change', async () => {
    const { req, res } = makeReqRes('PATCH', {
      query: { id: 'p1' },
      body: { totalCap: null, reason: 'Sales-approved campaign' },
    });
    await handlers.patch(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(repo.updatePackage).toHaveBeenCalledWith('p1', { totalCap: null, reason: 'Sales-approved campaign' });
    expect(audit).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'credits.grant_package.updated',
        changes: [{ field: 'totalCap', before: 1, after: null }],
      })
    );
  });

  it('returns the stored package without a write or audit entry when nothing changed', async () => {
    const { req, res } = makeReqRes('PATCH', { query: { id: 'p1' }, body: { active: true, totalCap: 1 } });
    await handlers.patch(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ id: 'p1' });
    expect(repo.updatePackage).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects an edit that leaves the daily cap above the stored total cap', async () => {
    repo.findById.mockResolvedValue({ ...stored, totalCap: 10, dailyCap: 5 });
    const { req, res } = makeReqRes('PATCH', { query: { id: 'p1' }, body: { dailyCap: 11 } });
    await expect(handlers.patch(req, res)).rejects.toThrow(/dailyCap: must not exceed totalCap/);
    expect(repo.updatePackage).not.toHaveBeenCalled();
  });

  it('deactivates without a reason', async () => {
    const { req, res } = makeReqRes('PATCH', { query: { id: 'p1' }, body: { active: false } });
    await handlers.patch(req, res);
    expect(repo.updatePackage).toHaveBeenCalledWith('p1', { active: false });
  });

  it('404s an unknown package', async () => {
    repo.findById.mockResolvedValue(null);
    const { req, res } = makeReqRes('PATCH', { query: { id: 'nope' }, body: { active: false } });
    await expect(handlers.patch(req, res)).rejects.toThrow(/not found/i);
  });

  it('rejects a non-admin with 403', async () => {
    const { req, res } = makeReqRes('PATCH', {
      user: { isAdmin: false },
      query: { id: 'p1' },
      body: { active: false },
    });
    await expect(handlers.patch(req, res)).rejects.toThrow(/missing permission/i);
  });
});
