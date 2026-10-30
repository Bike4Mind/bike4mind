import { describe, it, expect, vi, beforeEach } from 'vitest';

const { purgeMock, purgeBySourceMock, invalidateManyMock, deleteThumbnailsMock } = vi.hoisted(() => ({
  purgeMock: vi.fn(),
  purgeBySourceMock: vi.fn(),
  invalidateManyMock: vi.fn(),
  deleteThumbnailsMock: vi.fn(),
}));

vi.mock('@bike4mind/server-utils/utils/publishThumbnails', () => ({
  deletePublishThumbnails: deleteThumbnailsMock,
}));

vi.mock('@bike4mind/database', () => ({
  purgeOwnerPublishedArtifacts: purgeMock,
  purgeOwnerPublishedArtifactsBySource: purgeBySourceMock,
}));
vi.mock('./invalidatePublishCdn', async importOriginal => ({
  ...(await importOriginal<typeof import('./invalidatePublishCdn')>()),
  invalidatePublishCdnMany: invalidateManyMock,
}));

import { purgeUserPublishedArtifacts, unpublishUserArtifactsBySource } from './purgeUserPublishedArtifacts';

const purged = (publicId: string, visibility: string, kind = 'bundle') => ({
  publicId,
  tier: 'user',
  scopeId: 'u1',
  slug: `s-${publicId}`,
  visibility,
  source: { kind },
});

const invalidatedIds = () =>
  invalidateManyMock.mock.calls.flatMap(([targets]) => (targets as { publicId: string }[]).map(t => t.publicId));

beforeEach(() => {
  purgeMock.mockReset();
  purgeBySourceMock.mockReset();
  invalidateManyMock.mockReset().mockResolvedValue(undefined);
  deleteThumbnailsMock.mockReset().mockResolvedValue(0);
});

describe('purgeUserPublishedArtifacts', () => {
  it('deletes the owner-only thumbnails of the removed bundles, not of replies or transferred org pages', async () => {
    purgeMock.mockResolvedValue({
      artifacts: [purged('pub', 'public'), purged('priv', 'private'), purged('rep', 'public', 'reply')],
      transferred: [{ ...purged('org-pub', 'public'), ownerId: 'u2' }],
      annotations: 0,
      reports: 0,
      viewAudits: 0,
    });
    const logger = { info: vi.fn(), warn: vi.fn() };

    await purgeUserPublishedArtifacts('u1', { deletedBy: 'admin1', logger });

    expect(deleteThumbnailsMock).toHaveBeenCalledTimes(1);
    expect(deleteThumbnailsMock).toHaveBeenCalledWith(['pub', 'priv'], logger);
  });

  it('deletes no thumbnails when the database purge failed', async () => {
    purgeMock.mockRejectedValue(new Error('db down'));
    await expect(purgeUserPublishedArtifacts('u1', { deletedBy: 'admin1' })).rejects.toThrow('db down');
    expect(deleteThumbnailsMock).not.toHaveBeenCalled();
  });

  it('purges the owner and invalidates the CDN for the public artifacts only', async () => {
    purgeMock.mockResolvedValue({
      artifacts: [purged('pub', 'public'), purged('priv', 'private'), purged('rep', 'public', 'reply')],
      transferred: [],
      annotations: 0,
      reports: 0,
      viewAudits: 0,
    });

    const result = await purgeUserPublishedArtifacts('u1', { deletedBy: 'admin1' });

    expect(purgeMock).toHaveBeenCalledWith('u1', { deletedBy: 'admin1' });
    expect(result.artifacts).toHaveLength(3);
    expect(invalidateManyMock).toHaveBeenCalledTimes(1);
    expect(invalidatedIds()).toEqual(['pub', 'rep']);
    expect(invalidateManyMock.mock.calls[0][0][1]).toMatchObject({ sourceKind: 'reply' });
  });

  it('invalidates the CDN for public org pages handed to their last publisher', async () => {
    purgeMock.mockResolvedValue({
      artifacts: [],
      transferred: [
        { ...purged('org-pub', 'public'), ownerId: 'u2' },
        { ...purged('org-priv', 'private'), ownerId: 'u2' },
      ],
      annotations: 0,
      reports: 0,
      viewAudits: 0,
    });

    await purgeUserPublishedArtifacts('u1', { deletedBy: 'admin1' });

    expect(invalidatedIds()).toEqual(['org-pub']);
  });

  it('issues no invalidation when nothing was live', async () => {
    purgeMock.mockResolvedValue({ artifacts: [], transferred: [], annotations: 0, reports: 0, viewAudits: 0 });

    await purgeUserPublishedArtifacts('u1', { deletedBy: 'admin1' });

    expect(invalidatedIds()).toEqual([]);
  });

  it('propagates a database failure to the caller', async () => {
    purgeMock.mockRejectedValue(new Error('db down'));

    await expect(purgeUserPublishedArtifacts('u1', { deletedBy: 'admin1' })).rejects.toThrow('db down');
    expect(invalidateManyMock).not.toHaveBeenCalled();
  });
});

describe('unpublishUserArtifactsBySource', () => {
  it('takes down by source as the owner and invalidates the public pages in one pass', async () => {
    purgeBySourceMock.mockResolvedValue({
      artifacts: [purged('r1', 'public', 'reply'), purged('r2', 'private', 'reply'), purged('r3', 'public', 'reply')],
      annotations: 0,
      reports: 0,
      viewAudits: 0,
    });

    const result = await unpublishUserArtifactsBySource('u1', { kind: 'reply', sessionIds: ['s1'] });

    expect(purgeBySourceMock).toHaveBeenCalledWith('u1', { kind: 'reply', sessionIds: ['s1'] }, { deletedBy: 'u1' });
    expect(result.artifacts).toHaveLength(3);
    expect(invalidateManyMock).toHaveBeenCalledTimes(1);
    expect(invalidatedIds()).toEqual(['r1', 'r3']);
  });

  it('propagates a database failure so the delete does not go ahead', async () => {
    purgeBySourceMock.mockRejectedValue(new Error('db down'));

    await expect(unpublishUserArtifactsBySource('u1', { kind: 'fabfile', fabFileIds: ['f1'] })).rejects.toThrow(
      'db down'
    );
    expect(invalidateManyMock).not.toHaveBeenCalled();
  });
});
