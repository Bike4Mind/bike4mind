import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { handlers, baseOptions, listHeld } = vi.hoisted(() => ({
  handlers: {} as Record<string, (req: unknown, res: unknown) => Promise<void>>,
  baseOptions: vi.fn(),
  listHeld: vi.fn(),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => 'csrf' }));
const uses = vi.hoisted(() => [] as Array<(req: unknown, res: unknown, next: () => void) => void>);
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    baseOptions(options);
    const chain = {
      use: (fn: unknown) => {
        if (typeof fn === 'function') uses.push(fn as (typeof uses)[number]);
        return chain;
      },
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
const advisories = vi.hoisted(() => vi.fn());
vi.mock('@server/security/abuseAssessment/riskReviewAdvisory', () => ({ findRiskReviewAdvisories: advisories }));
const decisions = vi.hoisted(() => vi.fn());
vi.mock('@server/admin/ai/assessmentSuggestion', () => ({ withSuggestionDecisions: decisions }));
import '@pages/api/admin/held-signup-grants';

const run = async (query: Record<string, string>, isAdmin = true, user: Record<string, unknown> = {}) => {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, { user: { id: 'admin-1', isAdmin, ...user }, logger: { warn: vi.fn() } });
  await Promise.resolve()
    .then(() => {
      for (const middleware of uses) middleware(req, res, () => undefined);
      return handlers.get(req, res);
    })
    .catch((error: unknown) => (res.statusCode = (error as { statusCode?: number }).statusCode ?? 500));
  return res;
};
const row = (id: string) => ({ id, email: `${id}@example.test`, reason: 'budget_exhausted', createdAt: new Date(0) });

beforeEach(() => {
  listHeld.mockReset().mockResolvedValue([]);
  advisories.mockReset().mockResolvedValue(new Map());
  decisions
    .mockReset()
    .mockImplementation(
      async (_surface: string, found: Map<string, object>) =>
        new Map([...found].map(([userId, advisory]) => [userId, { ...advisory, decision: null }]))
    );
});

describe('GET /api/admin/held-signup-grants', () => {
  it('requires the admin scope on a JWT-only route', () => {
    expect(baseOptions).toHaveBeenCalledWith({ auth: 'jwtOnly', allowedMethods: ['GET'] });
  });
  it('rejects non-admins before querying', async () => {
    expect((await run({}, false)).statusCode).toBe(403);
    expect(listHeld).not.toHaveBeenCalled();
  });
  it('serves a delegate holding credits:adjust and refuses one without it', async () => {
    expect((await run({}, false, { adminPermissions: ['support:read'] })).statusCode).toBe(403);
    expect(listHeld).not.toHaveBeenCalled();
    expect((await run({}, false, { adminPermissions: ['credits:adjust'] })).statusCode).toBe(200);
    expect(listHeld).toHaveBeenCalledOnce();
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
  it('attaches the advisory model verdict to the rows it names, and null elsewhere', async () => {
    const [named, other] = ['a'.repeat(24), 'b'.repeat(24)];
    listHeld.mockResolvedValue([row(named), row(other)]);
    const advisory = { assessmentId: 'x1', detectionId: 'd1', result: 'abuse' };
    advisories.mockResolvedValue(new Map([[named, advisory]]));

    const body = (await run({}))._getJSONData();

    expect(advisories).toHaveBeenCalledWith([named, other], expect.anything());
    expect(decisions).toHaveBeenCalledWith('heldSignupGrant', expect.any(Map));
    expect(body.data.map((r: { advisory: unknown }) => r.advisory)).toEqual([{ ...advisory, decision: null }, null]);
  });
  it('still lists the held grants when the decision lookup fails', async () => {
    listHeld.mockResolvedValue([row('a'.repeat(24))]);
    advisories.mockResolvedValue(new Map([['a'.repeat(24), { assessmentId: 'x1' }]]));
    decisions.mockRejectedValue(new Error('read failed'));

    const res = await run({});

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData().data[0].advisory).toBeNull();
  });
  it('still lists the held grants when the advisory read fails', async () => {
    listHeld.mockResolvedValue([row('a'.repeat(24))]);
    advisories.mockRejectedValue(new Error('read failed'));

    const res = await run({});

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData().data[0].advisory).toBeNull();
  });
});
