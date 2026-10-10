import { describe, it, expect, vi, beforeEach } from 'vitest';

const { purgeMock, invalidateMock } = vi.hoisted(() => ({
  purgeMock: vi.fn(),
  invalidateMock: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({ purgeOwnerPublishedArtifacts: purgeMock }));
vi.mock('./invalidatePublishCdn', async importOriginal => ({
  ...(await importOriginal<typeof import('./invalidatePublishCdn')>()),
  invalidatePublishCdn: invalidateMock,
}));

import { purgeUserPublishedArtifacts } from './purgeUserPublishedArtifacts';

const purged = (publicId: string, visibility: string, kind = 'bundle') => ({
  publicId,
  tier: 'user',
  scopeId: 'u1',
  slug: `s-${publicId}`,
  visibility,
  source: { kind },
});

beforeEach(() => {
  purgeMock.mockReset();
  invalidateMock.mockReset().mockResolvedValue(undefined);
});

describe('purgeUserPublishedArtifacts', () => {
  it('purges the owner and invalidates the CDN for the public artifacts only', async () => {
    purgeMock.mockResolvedValue({
      artifacts: [purged('pub', 'public'), purged('priv', 'private'), purged('rep', 'public', 'reply')],
      annotations: 0,
      reports: 0,
      viewAudits: 0,
    });

    const result = await purgeUserPublishedArtifacts('u1', { deletedBy: 'admin1' });

    expect(purgeMock).toHaveBeenCalledWith('u1', { deletedBy: 'admin1' });
    expect(result.artifacts).toHaveLength(3);
    expect(invalidateMock).toHaveBeenCalledTimes(2);
    expect(invalidateMock.mock.calls.map(([target]) => target.publicId)).toEqual(['pub', 'rep']);
    expect(invalidateMock.mock.calls[1][0]).toMatchObject({ sourceKind: 'reply' });
  });

  it('issues no invalidation when nothing was live', async () => {
    purgeMock.mockResolvedValue({ artifacts: [], annotations: 0, reports: 0, viewAudits: 0 });

    await purgeUserPublishedArtifacts('u1', { deletedBy: 'admin1' });

    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it('propagates a database failure to the caller', async () => {
    purgeMock.mockRejectedValue(new Error('db down'));

    await expect(purgeUserPublishedArtifacts('u1', { deletedBy: 'admin1' })).rejects.toThrow('db down');
    expect(invalidateMock).not.toHaveBeenCalled();
  });
});
