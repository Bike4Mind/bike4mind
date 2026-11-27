import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { RequestHandler } from 'express';
const mocks = vi.hoisted(() => ({
  get: undefined as RequestHandler | undefined,
  findById: vi.fn(),
  find: vi.fn(),
  lean: vi.fn(),
  baseApi: vi.fn(),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    mocks.baseApi(options);
    return {
      get: (fn: RequestHandler) => {
        mocks.get = fn;
        return {};
      },
    };
  },
}));
vi.mock('@bike4mind/database/infra', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/database/infra')>()),
  organizationRepository: { findById: mocks.findById },
  OrganizationAuditEventModel: { find: mocks.find },
}));
import '@pages/api/organizations/[id]/audit';

const run = async (userId: string, query: Record<string, string> = {}) => {
  const { req, res } = createMocks({ method: 'GET', query: { id: 'org-a', ...query } });
  Object.assign(req, { user: { id: userId, isAdmin: userId === 'platform' } });
  await mocks.get!(req, res, vi.fn());
  return res;
};
describe('organization audit route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findById.mockResolvedValue({
      id: 'org-a',
      userId: 'owner',
      adminUserIds: ['manager', 'stale'],
      users: [{ userId: 'manager', permissions: ['read'] }],
    });
    mocks.find.mockReturnValue({ sort: () => ({ limit: () => ({ lean: mocks.lean }) }) });
    mocks.lean.mockResolvedValue([]);
  });
  it('denies other orgs, ordinary members, stale managers and unrelated platform staff before querying', async () => {
    for (const id of ['org-b-owner', 'member', 'stale', 'platform'])
      await expect(run(id)).rejects.toThrow('access denied');
    expect(mocks.find).not.toHaveBeenCalled();
  });
  it('serves owner and current manager from the org-only collection', async () => {
    for (const id of ['owner', 'manager'])
      expect((await run(id))._getJSONData()).toEqual({ events: [], nextCursor: null });
    expect(mocks.find).toHaveBeenCalledWith({ organizationId: 'org-a' });
  });
  it('exports the requested inclusive UTC date range without accepting a pagination cursor', async () => {
    mocks.lean.mockResolvedValue([
      {
        _id: 'id',
        organizationId: 'org-a',
        actorUserId: 'owner',
        action: 'policy.updated',
        occurredAt: new Date('2026-01-02Z'),
      },
    ]);
    const res = await run('manager', {
      from: '2026-01-01',
      to: '2026-01-02',
      format: 'csv',
      before: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(mocks.find).toHaveBeenCalledWith({
      organizationId: 'org-a',
      occurredAt: { $gte: new Date('2026-01-01Z'), $lt: new Date('2026-01-03Z') },
    });
    expect(res.getHeader('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res._getData()).toContain('2026-01-02T00:00:00.000Z');
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });
  it('requires export dates and rejects truncated exports', async () => {
    await expect(run('owner', { format: 'csv' })).rejects.toThrow('requires a date range');
    mocks.lean.mockResolvedValue(Array(10001).fill({}));
    await expect(run('owner', { format: 'csv', from: '2026-01-01', to: '2026-01-01' })).rejects.toThrow(
      'smaller date range'
    );
  });
});
