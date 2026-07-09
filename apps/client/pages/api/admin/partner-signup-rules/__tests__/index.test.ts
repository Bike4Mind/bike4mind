import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Capture the route handlers registered on the baseApi chain so each method can be
// invoked directly (same middleware-strip pattern as pages/api/email/__tests__/verify.test.ts).
// Everything referenced inside a vi.mock factory must live in vi.hoisted (mocks are hoisted
// above top-level const initialization).
const { handlers, repo, invalidatePartnerRuleCache } = vi.hoisted(() => ({
  handlers: {} as Record<string, (req: unknown, res: unknown) => unknown>,
  repo: { listRules: vi.fn(), findByDomain: vi.fn(), create: vi.fn() },
  invalidatePartnerRuleCache: vi.fn(),
}));

vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, (fn: (req: unknown, res: unknown) => unknown) => unknown> = {};
    for (const method of ['get', 'post', 'put', 'delete']) {
      chain[method] = (fn: (req: unknown, res: unknown) => unknown) => {
        handlers[method] = fn;
        return chain;
      };
    }
    return chain;
  },
}));

vi.mock('@bike4mind/database', () => ({ partnerSignupRuleRepository: repo }));
vi.mock('@server/entitlements/partnerRules', () => ({ invalidatePartnerRuleCache }));

// Importing the route registers handlers.get / handlers.post via the mocked baseApi.
import '@pages/api/admin/partner-signup-rules/index';

type ReqOverrides = { user?: unknown; body?: unknown; query?: unknown };
function makeReqRes(method: string, over: ReqOverrides = {}) {
  const { req, res } = createMocks({ method });
  (req as { user?: unknown }).user = 'user' in over ? over.user : { isAdmin: true, id: 'admin-1' };
  (req as { body?: unknown }).body = over.body ?? {};
  (req as { query?: unknown }).query = over.query ?? {};
  return { req, res };
}

const validRule = { domain: 'partner.com', entitlements: ['optihashi:pro'], signupCredits: 150_000 };

describe('/api/admin/partner-signup-rules — create (POST)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repo.findByDomain.mockResolvedValue(null);
    repo.create.mockResolvedValue({ id: 'r1', ...validRule, enabled: true });
  });

  it('rejects a non-admin with 403 (ForbiddenError) and never writes', async () => {
    const { req, res } = makeReqRes('POST', { user: { isAdmin: false }, body: validRule });
    await expect(handlers.post(req, res)).rejects.toThrow(/admin access required/i);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects an invalid body with a 400 (Zod message)', async () => {
    const { req, res } = makeReqRes('POST', { body: { ...validRule, domain: 'gmail.com' } });
    await expect(handlers.post(req, res)).rejects.toThrow(/public mail providers/i);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects a duplicate domain (pre-check) with a 400', async () => {
    repo.findByDomain.mockResolvedValue({ id: 'existing', ...validRule });
    const { req, res } = makeReqRes('POST', { body: validRule });
    await expect(handlers.post(req, res)).rejects.toThrow(/already exists/i);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('maps a unique-index race (Mongo 11000) to a 400 instead of a 500', async () => {
    repo.create.mockRejectedValueOnce(Object.assign(new Error('E11000 dup key'), { code: 11000 }));
    const { req, res } = makeReqRes('POST', { body: validRule });
    await expect(handlers.post(req, res)).rejects.toThrow(/already exists/i);
  });

  it('creates the rule (201), stamps createdBy, and busts the cache', async () => {
    const { req, res } = makeReqRes('POST', { body: validRule });
    await handlers.post(req, res);
    expect(res._getStatusCode()).toBe(201);
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ domain: 'partner.com', createdBy: 'admin-1' }));
    expect(invalidatePartnerRuleCache).toHaveBeenCalledTimes(1);
  });
});

describe('/api/admin/partner-signup-rules — list (GET)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repo.listRules.mockResolvedValue({ data: [], meta: { currentPage: 1, totalPages: 0, total: 0 } });
  });

  it('rejects a non-admin', async () => {
    const { req, res } = makeReqRes('GET', { user: { isAdmin: false } });
    await expect(handlers.get(req, res)).rejects.toThrow(/admin access required/i);
    expect(repo.listRules).not.toHaveBeenCalled();
  });

  it('returns paginated rules for an admin with coerced query defaults', async () => {
    const { req, res } = makeReqRes('GET', { query: {} });
    await handlers.get(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(repo.listRules).toHaveBeenCalledWith(expect.objectContaining({ page: 1, limit: 25 }));
  });
});
