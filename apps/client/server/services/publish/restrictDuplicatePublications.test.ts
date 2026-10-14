import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findMock, leanMock, updateManyMock, invalidateMock } = vi.hoisted(() => ({
  findMock: vi.fn(),
  leanMock: vi.fn(),
  updateManyMock: vi.fn(),
  invalidateMock: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: {
    find: (filter: unknown) => {
      findMock(filter);
      return { select: () => ({ lean: leanMock }) };
    },
    updateMany: updateManyMock,
  },
}));
vi.mock('./invalidatePublishCdn', async importOriginal => ({
  ...(await importOriginal<typeof import('./invalidatePublishCdn')>()),
  invalidatePublishCdn: invalidateMock,
}));

import { restrictDuplicatePublications, type DuplicateKeeper } from './restrictDuplicatePublications';

const keeper = (over: Partial<DuplicateKeeper> = {}): DuplicateKeeper => ({
  _id: 'keep',
  ownerId: 'owner1',
  visibility: 'private',
  source: { kind: 'reply', messageId: 'msg1' },
  ...over,
});
const sibling = (publicId: string, visibility: string) => ({
  _id: `id-${publicId}`,
  publicId,
  tier: 'organization',
  scopeId: 'org1',
  slug: `r-${publicId}`,
  source: { kind: 'reply' },
  visibility,
});

beforeEach(() => {
  findMock.mockReset();
  leanMock.mockReset().mockResolvedValue([]);
  updateManyMock.mockReset().mockResolvedValue({});
  invalidateMock.mockReset().mockResolvedValue(undefined);
});

describe('restrictDuplicatePublications', () => {
  it('sets every more-open duplicate of the reply to private and purges the public ones', async () => {
    leanMock.mockResolvedValue([sibling('old-pub', 'public'), sibling('old-team', 'organization')]);

    expect(await restrictDuplicatePublications(keeper())).toBe(2);

    expect(findMock).toHaveBeenCalledWith({
      _id: { $ne: 'keep' },
      ownerId: 'owner1',
      'source.kind': 'reply',
      'source.messageId': 'msg1',
      deletedAt: null,
      visibility: { $in: ['project', 'organization', 'public'] },
    });
    expect(updateManyMock).toHaveBeenCalledWith(
      { _id: { $in: ['id-old-pub', 'id-old-team'] }, ownerId: 'owner1', deletedAt: null },
      { $set: { visibility: 'private', discoverable: false } }
    );
    expect(invalidateMock).toHaveBeenCalledTimes(1);
    expect(invalidateMock.mock.calls[0][0]).toMatchObject({ publicId: 'old-pub', sourceKind: 'reply' });
  });

  it('for a Team keeper, only narrows duplicates that are still public', async () => {
    await restrictDuplicatePublications(keeper({ visibility: 'organization' }));
    expect(findMock).toHaveBeenCalledWith(expect.objectContaining({ visibility: { $in: ['public'] } }));
  });

  it('for a project keeper, also narrows Team duplicates, which are more open than project', async () => {
    await restrictDuplicatePublications(keeper({ visibility: 'project' }));
    expect(findMock).toHaveBeenCalledWith(expect.objectContaining({ visibility: { $in: ['organization', 'public'] } }));
  });

  it('keys a file on its fabFileId', async () => {
    await restrictDuplicatePublications(keeper({ source: { kind: 'fabfile', fabFileId: 'f1' } }));
    expect(findMock).toHaveBeenCalledWith(
      expect.objectContaining({ 'source.kind': 'fabfile', 'source.fabFileId': 'f1' })
    );
  });

  it('never widens: a public keeper leaves duplicates alone', async () => {
    expect(await restrictDuplicatePublications(keeper({ visibility: 'public' }))).toBe(0);
    expect(findMock).not.toHaveBeenCalled();
  });

  it('skips bundles, which may legitimately be published more than once', async () => {
    expect(await restrictDuplicatePublications(keeper({ source: { kind: 'bundle' } }))).toBe(0);
    expect(findMock).not.toHaveBeenCalled();
  });

  it('writes nothing when there are no duplicates', async () => {
    expect(await restrictDuplicatePublications(keeper())).toBe(0);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(invalidateMock).not.toHaveBeenCalled();
  });
});
