import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createMocks } from 'node-mocks-http';

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
const h = vi.hoisted(() => ({
  handlers: [] as Handler[],
  memberships: vi.fn(),
  find: vi.fn(),
  findOne: vi.fn(),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    get: (fn: Handler) => {
      h.handlers.push(fn);
      return fn;
    },
  }),
}));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: { findMembershipOrgIds: h.memberships } }));
vi.mock('@bike4mind/database', () => ({ OrganizationLibrary: { find: h.find, findOne: h.findOne } }));
import '../index';
import '../[id]';

const ID = '0123456789abcdef01234567';
const run = async (index: number) => {
  const { req, res } = createMocks({ method: 'GET', query: { id: ID } });
  Object.assign(req, { user: { id: 'member' } });
  await h.handlers[index](req as unknown as Request, res as unknown as Response, vi.fn());
  return res;
};

describe('member library discovery and click-time reads', () => {
  const summary = { id: ID, organizationId: 'org-a', name: 'Helper', description: 'Help', kind: 'skill', pinned: true };
  beforeEach(() => {
    vi.clearAllMocks();
    h.memberships.mockResolvedValue(['org-a']);
  });
  it('lists only current membership scopes and strips extra persisted fields', async () => {
    h.find.mockReturnValue({
      select: () => ({ sort: async () => [{ ...summary, userId: 'private', definition: { body: 'not metadata' } }] }),
    });
    const res = await run(0);
    expect(h.find).toHaveBeenCalledWith({ organizationId: { $in: ['org-a'] } });
    expect(res._getJSONData()).toEqual({ items: [summary] });
  });
  it('lets a remaining member read a retained definition without looking up its author', async () => {
    h.findOne.mockResolvedValue({
      ...summary,
      definition: { name: 'Helper', body: 'Retained instructions', userId: 'departed-author' },
    });
    const res = await run(1);
    expect(h.findOne).toHaveBeenCalledWith({ _id: ID, organizationId: { $in: ['org-a'] } });
    expect(res._getJSONData().item.definition).toEqual({ name: 'Helper', body: 'Retained instructions' });
    expect(h.memberships).toHaveBeenCalledWith('member');
  });
  it('refuses a cross-org item or a departed member using the same not-found response', async () => {
    h.memberships.mockResolvedValue([]);
    h.findOne.mockResolvedValue(null);
    await expect(run(1)).rejects.toThrow('Library item not found');
    expect(h.findOne).toHaveBeenCalledWith({ _id: ID, organizationId: { $in: [] } });
  });
});
