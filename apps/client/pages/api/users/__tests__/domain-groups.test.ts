import { describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({ find: vi.fn(), aggregate: vi.fn(), groups: vi.fn() }));
vi.mock('@server/middlewares/baseApi', () => ({ baseApi: () => ({ get: (handler: unknown) => handler }) }));
vi.mock('@bike4mind/database', () => ({
  User: { find: mocks.find, aggregate: mocks.aggregate },
  Project: {},
  projectRepository: {},
  mongoose: {},
  executeFacetCompatible: vi.fn(),
  convertPipelineForDocumentDB: vi.fn(),
}));
vi.mock('@server/users/signupAnomaly', () => ({ getDomainGroups: mocks.groups, SIGNUP_SCAN_LIMIT: 2 }));
vi.mock('@casl/mongoose', () => ({ accessibleBy: () => ({ ofType: () => ({}) }) }));
vi.mock('@server/users/sharedWorkspaceUserIds', () => ({ findSharedWorkspaceUserIds: vi.fn() }));
vi.mock('@server/users/pendingProjectInviteeIds', () => ({ findPendingProjectInviteeIds: vi.fn() }));
import handler from '../index';

describe('domain grouping handler', () => {
  it('caps indexed candidates before joins and preserves cohort filters', async () => {
    const chain = {
      sort: vi.fn(),
      hint: vi.fn(),
      select: vi.fn(),
      limit: vi.fn(),
      maxTimeMS: vi.fn(),
      lean: vi.fn().mockResolvedValue([{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }]),
    };
    for (const method of [chain.sort, chain.hint, chain.select, chain.limit, chain.maxTimeMS])
      method.mockReturnValue(chain);
    mocks.find.mockReturnValue(chain);
    const rows = [{ _id: 'a', email: 'a@example.test', createdAt: new Date() }];
    const option = vi.fn().mockResolvedValue(rows);
    mocks.aggregate.mockReturnValue({ option });
    mocks.groups.mockResolvedValue({ groups: [{ domain: 'example.test', userIds: ['a'] }], keysTruncated: true });
    const { req, res } = createMocks({
      query: { groupBy: 'emailDomain', recentSignups: 'hour', tags: ['Review'], orgSearch: ['Example'] },
    });
    Object.assign(req, { user: { isAdmin: true } });
    await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
    expect(chain.hint).toHaveBeenCalledWith({ createdAt: 1 });
    expect(chain.limit).toHaveBeenCalledWith(3);
    expect(mocks.find.mock.calls[0][0]).toHaveProperty('createdAt');
    const pipeline = mocks.aggregate.mock.calls[0][0];
    expect(JSON.stringify(pipeline[0])).toContain('createdAt');
    expect(JSON.stringify(pipeline[0])).toContain('Review');
    expect(pipeline[0].$match.$and[1]).toEqual({ _id: { $in: ['a', 'b'] } });
    expect(JSON.stringify(pipeline)).toContain('Example');
    expect(option).toHaveBeenCalledWith({ maxTimeMS: 2000 });
    expect(mocks.groups).toHaveBeenCalledWith(rows);
    expect(res._getJSONData()).toMatchObject({ groupsTruncated: true, keysTruncated: true, totalUsers: 1 });
  });

  it('skips the organization join without an org filter and scans the same window it filters on', async () => {
    mocks.find.mockClear();
    mocks.aggregate.mockClear();
    const chain = {
      sort: vi.fn(),
      hint: vi.fn(),
      select: vi.fn(),
      limit: vi.fn(),
      maxTimeMS: vi.fn(),
      lean: vi.fn().mockResolvedValue([{ _id: 'a' }]),
    };
    for (const method of [chain.sort, chain.hint, chain.select, chain.limit, chain.maxTimeMS])
      method.mockReturnValue(chain);
    mocks.find.mockReturnValue(chain);
    mocks.aggregate.mockReturnValue({ option: vi.fn().mockResolvedValue([]) });
    mocks.groups.mockResolvedValue({ groups: [], keysTruncated: false });
    const { req, res } = createMocks({ query: { groupBy: 'emailDomain', recentSignups: 'hour' } });
    Object.assign(req, { user: { isAdmin: true } });
    await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
    const pipeline = mocks.aggregate.mock.calls[0][0];
    expect(JSON.stringify(pipeline)).not.toContain('$lookup');
    expect(pipeline[0].$match.$and[0].$and[1].$and).toContainEqual(mocks.find.mock.calls[0][0]);
  });
});
