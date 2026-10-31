import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => handlers[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.GET = fn), chain),
      _config: config,
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));

const mockList = vi.fn();
const mockGroups = vi.fn();
const mockSummary = vi.fn();
vi.mock('@server/admin/usersList/listAdminUsers', () => ({
  listAdminUsers: (...args: unknown[]) => mockList(...args),
  adminUsersDomainGroups: (...args: unknown[]) => mockGroups(...args),
  adminUsersSummary: (...args: unknown[]) => mockSummary(...args),
}));

import handler from '../index';
import summaryHandler from '../summary';

const ADMIN = { id: 'a'.repeat(24), isAdmin: true };
type Handler = (req: unknown, res: unknown) => Promise<unknown>;

async function call(target: unknown, query: Record<string, string>, user: Record<string, unknown> = ADMIN) {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, { user, logger: { error: vi.fn() } });
  await (target as Handler)(req, res);
  return res;
}

describe('GET /api/admin/users', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue({ users: [], totalUsers: 0, page: 1, totalPages: 0 });
    mockGroups.mockResolvedValue({ groups: [], groupsTruncated: false, keysTruncated: false });
  });

  it('requires JWT auth with admin scope', () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
    });
  });

  it('refuses a non-admin before reading anything', async () => {
    await expect(call(handler, {}, { ...ADMIN, isAdmin: false })).rejects.toThrow('Admin access required');
    expect(mockList).not.toHaveBeenCalled();
  });

  it('passes the parsed filter, page and sort to the list', async () => {
    const res = await call(handler, {
      status: 'suspended',
      emailDomain: 'Example.com',
      page: '3',
      limit: '50',
      sortField: 'lastActiveAt',
      sortOrder: 'asc',
    });
    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'suspended',
        emailDomain: 'example.com',
        page: 3,
        limit: 50,
        sortField: 'lastActiveAt',
        sortOrder: 'asc',
      }),
      { userId: ADMIN.id, isAdmin: true },
      expect.objectContaining({ logError: expect.any(Function) })
    );
  });

  it('returns domain groups instead of a page when grouping', async () => {
    const res = await call(handler, { groupBy: 'emailDomain', risk: 'high' });
    expect(res._getJSONData()).toEqual({ groups: [], groupsTruncated: false, keysTruncated: false });
    expect(mockGroups).toHaveBeenCalledWith(expect.objectContaining({ risk: 'high' }));
    expect(mockList).not.toHaveBeenCalled();
  });

  it("accepts up to 50 tags, past qs's default array limit of 20", async () => {
    const tags = Array.from({ length: 50 }, (_, index) => `tag${index}`);
    const query = Object.fromEntries(tags.map((tag, index) => [`tags[${index}]`, tag]));
    expect((await call(handler, query))._getStatusCode()).toBe(200);
    expect(mockList.mock.calls[0][0]).toMatchObject({ tags });
  });

  it('rejects an unknown page size or sort with 400', async () => {
    expect((await call(handler, { limit: '1000' }))._getStatusCode()).toBe(400);
    expect((await call(handler, { sortField: 'passwordHash' }))._getStatusCode()).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  describe('analytics drill-down filters', () => {
    const month = { createdFrom: '2026-10-01T00:00:00.000Z', createdTo: '2026-11-01T00:00:00.000Z' };
    const rejected = async (query: Record<string, string>, message: RegExp) => {
      const res = await call(handler, query);
      expect(res._getStatusCode(), JSON.stringify(query)).toBe(400);
      const { error, issues } = res._getJSONData() as { error: string; issues: { message: string }[] };
      expect(issues.map(issue => issue.message).join('\n')).toMatch(message);
      expect(error).toBe(issues[0].message);
    };

    it('forwards a verdict with its created window', async () => {
      expect((await call(handler, { ...month, verdict: 'suspected' }))._getStatusCode()).toBe(200);
      expect(mockList.mock.calls[0][0]).toMatchObject({ ...month, verdict: 'suspected' });
    });

    it('rejects a verdict that is unknown, has no created window or spans too long', async () => {
      await rejected({ ...month, verdict: 'unclassified' }, /suspected|legit/);
      await rejected({ verdict: 'legit', createdFrom: month.createdFrom }, /needs both createdFrom and createdTo/);
      const res = await call(handler, { verdict: 'suspected' });
      expect(res._getJSONData()).toMatchObject({ error: 'verdict needs both createdFrom and createdTo' });
      await rejected({ ...month, verdict: 'legit', createdTo: '2027-01-03T00:00:00.000Z' }, /at most 93 days/);
      expect(mockList).not.toHaveBeenCalled();
    });

    it('forwards an active window, a single day included', async () => {
      expect((await call(handler, { activeFrom: '2026-10-03', activeTo: '2026-10-03' }))._getStatusCode()).toBe(200);
      expect((await call(handler, { activeFrom: '2026-10-01', activeTo: '2026-10-07' }))._getStatusCode()).toBe(200);
      expect(mockList.mock.calls.map(([params]) => [params.activeFrom, params.activeTo])).toEqual([
        ['2026-10-03', '2026-10-03'],
        ['2026-10-01', '2026-10-07'],
      ]);
    });

    it('rejects an active window that is malformed, half set, reversed or over 366 days', async () => {
      await rejected({ activeFrom: '2026-02-30', activeTo: '2026-03-01' }, /UTC day/);
      await rejected({ activeFrom: '10/03/2026', activeTo: '2026-10-03' }, /UTC day/);
      await rejected({ activeFrom: '2026-10-03' }, /set together/);
      const res = await call(handler, { activeFrom: '2026-10-03' });
      expect(res._getJSONData()).toMatchObject({ error: 'activeFrom and activeTo must be set together' });
      await rejected({ activeTo: '2026-10-03' }, /set together/);
      await rejected({ activeFrom: '2026-10-07', activeTo: '2026-10-01' }, /not be before/);
      await rejected({ activeFrom: '2025-10-01', activeTo: '2026-10-02' }, /at most 366 days/);
      expect(mockList).not.toHaveBeenCalled();
    });

    it('forwards a funnel step alongside a verdict, and to the domain groups too', async () => {
      expect((await call(handler, { ...month, verdict: 'legit', funnelStep: 'cameBack' }))._getStatusCode()).toBe(200);
      expect(mockList.mock.calls[0][0]).toMatchObject({ ...month, verdict: 'legit', funnelStep: 'cameBack' });
      await call(handler, { ...month, funnelStep: 'paid', groupBy: 'emailDomain' });
      expect(mockGroups).toHaveBeenCalledWith(expect.objectContaining({ funnelStep: 'paid' }));
    });

    it('rejects a funnel step that is unknown, has no created window or spans too long', async () => {
      await rejected({ ...month, funnelStep: 'bought' }, /signedUp/);
      await rejected({ funnelStep: 'firstAction' }, /needs both createdFrom and createdTo/);
      const res = await call(handler, { funnelStep: 'firstAction' });
      expect(res._getJSONData()).toMatchObject({ error: 'funnelStep needs both createdFrom and createdTo' });
      await rejected(
        { funnelStep: 'paid', createdFrom: '2026-01-01T00:00:00.000Z', createdTo: month.createdTo },
        /93 days/
      );
      expect(mockList).not.toHaveBeenCalled();
      expect(mockGroups).not.toHaveBeenCalled();
    });
  });
});

describe('GET /api/admin/users/summary', () => {
  it('returns the counts to an admin only', async () => {
    const summary = { total: 3, activeThisWeek: 1, views: { newThisWeek: 2, highRisk: 1, suspended: 0 } };
    mockSummary.mockResolvedValue(summary);
    expect((await call(summaryHandler, {}))._getJSONData()).toEqual(summary);
    await expect(call(summaryHandler, {}, { ...ADMIN, isAdmin: false })).rejects.toThrow('Admin access required');
  });
});
