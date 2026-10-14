import { describe, it, expect, vi } from 'vitest';
import type { AccessContext, IDataLakeDocument } from '@bike4mind/common';
import { listDataLakes, listAllDataLakes } from './listDataLakes';

const ctx = (overrides: Partial<AccessContext> = {}): AccessContext => ({
  userId: 'alice',
  isAdmin: false,
  userTags: [],
  organizationIds: [],
  ...overrides,
});

const lake = (overrides: Partial<IDataLakeDocument> = {}): IDataLakeDocument =>
  ({
    id: 'lake1',
    name: 'Lake',
    slug: 'lake1',
    fileTagPrefix: 'lk:',
    datalakeTag: 'datalake:lake1',
    createdByUserId: 'alice',
    organizationId: 'orgA',
    status: 'active',
    pendingConnector: 'googleDrive',
    ...overrides,
  }) as IDataLakeDocument;

const repos = (lakes: IDataLakeDocument[], boundLakeIds: string[] | Error = []) => {
  const findBoundDataLakeIds = vi.fn((_ids: string[]) =>
    boundLakeIds instanceof Error ? Promise.reject(boundLakeIds) : Promise.resolve(boundLakeIds)
  );
  return {
    findBoundDataLakeIds,
    db: {
      dataLakes: {
        findAccessible: vi.fn().mockResolvedValue(lakes),
        find: vi.fn().mockResolvedValue(lakes),
        findIdsCreatedBy: vi.fn().mockResolvedValue([]),
      },
      gitHubLakeConnections: { findBoundDataLakeIds },
    },
  };
};

const byId = (result: { id: string }[], id: string) => result.find(l => l.id === id) as Record<string, unknown>;

describe('hasGitHubConnection on the manager list', () => {
  it('reports bound and unbound pending-connect lakes from one batched read', async () => {
    const { db, findBoundDataLakeIds } = repos(
      [lake({ id: 'bound', slug: 'bound' }), lake({ id: 'free', slug: 'free' })],
      ['bound']
    );
    const result = await listDataLakes(ctx(), { db });

    expect(byId(result, 'bound').hasGitHubConnection).toBe(true);
    expect(byId(result, 'free').hasGitHubConnection).toBe(false);
    expect(findBoundDataLakeIds).toHaveBeenCalledTimes(1);
    expect(findBoundDataLakeIds.mock.calls[0][0].sort()).toEqual(['bound', 'free']);
  });

  it('omits the field, and does not look the lake up, on a lake the caller cannot manage', async () => {
    const { db, findBoundDataLakeIds } = repos([lake({ createdByUserId: 'bob' })], ['lake1']);
    const result = await listDataLakes(ctx(), { db });

    expect(byId(result, 'lake1')).not.toHaveProperty('hasGitHubConnection');
    expect(byId(result, 'lake1')).not.toHaveProperty('pendingConnector');
    expect(findBoundDataLakeIds).not.toHaveBeenCalled();
  });

  it('omits the field on a manageable lake with no pendingConnector', async () => {
    const { db, findBoundDataLakeIds } = repos([lake({ pendingConnector: undefined })], ['lake1']);
    const result = await listDataLakes(ctx(), { db });

    expect(byId(result, 'lake1')).not.toHaveProperty('hasGitHubConnection');
    expect(findBoundDataLakeIds).not.toHaveBeenCalled();
  });

  it('omits the field when the lookup fails, so the client treats the binding as unknown', async () => {
    const { db } = repos([lake()], new Error('boom'));
    const logger = { warn: vi.fn() };
    const result = await listDataLakes(ctx(), { db, logger });

    expect(byId(result, 'lake1')).toHaveProperty('pendingConnector', 'googleDrive');
    expect(byId(result, 'lake1')).not.toHaveProperty('hasGitHubConnection');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('GitHub binding read failed'), expect.any(Error));
  });

  it('logs a failed lookup on the admin list too', async () => {
    const { db } = repos([lake({ createdByUserId: 'bob' })], new Error('boom'));
    const logger = { warn: vi.fn() };
    const result = await listAllDataLakes(ctx({ userId: 'admin', isAdmin: true }), { db, logger });

    expect(byId(result, 'lake1')).not.toHaveProperty('hasGitHubConnection');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('GitHub binding read failed'), expect.any(Error));
  });

  it('stays silent when the lookup succeeds', async () => {
    const { db } = repos([lake()], []);
    const logger = { warn: vi.fn() };
    await listDataLakes(ctx(), { db, logger });

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('reports it on the admin list too', async () => {
    const { db } = repos([lake({ createdByUserId: 'bob' })], ['lake1']);
    const result = await listAllDataLakes(ctx({ userId: 'admin', isAdmin: true }), { db });

    expect(byId(result, 'lake1').hasGitHubConnection).toBe(true);
  });
});
