import { describe, it, expect, beforeEach, vi } from 'vitest';
import { update } from './update';
import { UnauthorizedError } from '@bike4mind/utils';

/**
 * The single write gate (canUserWriteArtifact) lets a canWrite sharee edit content, but
 * permissions/visibility are owner-only: a sharee that could flip `isPublic`, rewrite `canWrite`, or
 * change visibility would self-escalate or lock out the owner. These pin that split.
 */

describe('artifactService - update (permission/visibility escalation guard)', () => {
  const ownerId = 'owner-id';
  const sharedWriterId = 'writer-id';

  let adapters: any;
  let artifact: any;

  beforeEach(() => {
    artifact = {
      id: 'artifact-1',
      userId: ownerId,
      deletedAt: null,
      contentHash: 'hash-existing',
      version: 1,
      permissions: { canRead: [], canWrite: [sharedWriterId], canDelete: [], isPublic: false },
      metadata: {},
    };

    adapters = {
      db: {
        artifacts: {
          findOne: vi.fn().mockResolvedValue(artifact),
          updateWithWriteAccess: vi.fn().mockImplementation(async (_userId: string, data: any) => ({
            ...artifact,
            ...data,
          })),
        },
        artifactContents: {
          createOrUpdate: vi.fn().mockResolvedValue({ _id: 'content-new' }),
          delete: vi.fn(),
          findByArtifactId: vi.fn().mockResolvedValue([]),
        },
        artifactVersions: {
          findByArtifactId: vi.fn().mockResolvedValue([]),
          findOne: vi.fn().mockResolvedValue(null),
          createOrUpdate: vi.fn().mockResolvedValue({ _id: 'version-new' }),
          update: vi.fn(),
          delete: vi.fn(),
        },
      },
    };
  });

  it('denies a non-owner writer that tries to change permissions', async () => {
    await expect(
      update(
        sharedWriterId,
        { id: 'artifact-1', permissions: { isPublic: true, canWrite: [sharedWriterId] } },
        adapters
      )
    ).rejects.toThrow(UnauthorizedError);
    expect(adapters.db.artifacts.updateWithWriteAccess).not.toHaveBeenCalled();
  });

  it('denies a non-owner writer that tries to change visibility', async () => {
    await expect(update(sharedWriterId, { id: 'artifact-1', visibility: 'public' }, adapters)).rejects.toThrow(
      UnauthorizedError
    );
    expect(adapters.db.artifacts.updateWithWriteAccess).not.toHaveBeenCalled();
  });

  it('lets a non-owner writer edit content', async () => {
    await update(sharedWriterId, { id: 'artifact-1', content: 'new body' }, adapters);
    expect(adapters.db.artifacts.updateWithWriteAccess).toHaveBeenCalled();
  });

  it('lets the owner change permissions and visibility', async () => {
    await update(ownerId, { id: 'artifact-1', visibility: 'public', permissions: { isPublic: true } }, adapters);
    expect(adapters.db.artifacts.updateWithWriteAccess).toHaveBeenCalledWith(
      ownerId,
      expect.objectContaining({
        visibility: 'public',
        permissions: expect.objectContaining({ isPublic: true }),
      })
    );
  });
});

describe('artifactService - update (write-time re-check)', () => {
  const writerId = 'writer-id';
  let adapters: any;

  beforeEach(() => {
    const artifact = {
      id: 'artifact-1',
      userId: 'owner-id',
      deletedAt: null,
      contentHash: 'hash-existing',
      version: 1,
      currentVersionId: 'version-prev',
      permissions: { canWrite: [writerId] },
      metadata: {},
    };
    adapters = {
      db: {
        artifacts: {
          findOne: vi.fn().mockResolvedValue(artifact),
          updateWithWriteAccess: vi
            .fn()
            .mockImplementation(async (_u: string, data: any) => ({ ...artifact, ...data })),
        },
        artifactContents: {
          createOrUpdate: vi.fn().mockResolvedValue({ _id: 'content-new' }),
          delete: vi.fn(),
        },
        artifactVersions: {
          findByArtifactId: vi.fn().mockResolvedValue([]),
          findOne: vi.fn().mockResolvedValue({ _id: 'version-prev' }),
          createOrUpdate: vi.fn().mockResolvedValue({ _id: 'version-new' }),
          update: vi.fn(),
          delete: vi.fn(),
        },
      },
    };
  });

  it('writes no version or content row when the gated claim matches nothing', async () => {
    adapters.db.artifacts.updateWithWriteAccess.mockResolvedValueOnce(null);

    await expect(update(writerId, { id: 'artifact-1', content: 'new body' }, adapters)).rejects.toThrow(
      UnauthorizedError
    );

    expect(adapters.db.artifactContents.createOrUpdate).not.toHaveBeenCalled();
    expect(adapters.db.artifactVersions.createOrUpdate).not.toHaveBeenCalled();
    expect(adapters.db.artifactVersions.update).not.toHaveBeenCalled();
  });

  it('points the artifact at the new version through the same gate', async () => {
    await update(writerId, { id: 'artifact-1', content: 'new body' }, adapters);

    expect(adapters.db.artifacts.updateWithWriteAccess).toHaveBeenLastCalledWith(
      writerId,
      expect.objectContaining({ id: 'artifact-1', version: 2, currentVersionId: 'version-new' })
    );
  });

  it('rolls the new rows back and reactivates the previous version when the pointer write is refused', async () => {
    adapters.db.artifacts.updateWithWriteAccess
      .mockImplementationOnce(async (_u: string, data: any) => data)
      .mockResolvedValueOnce(null);

    await expect(update(writerId, { id: 'artifact-1', content: 'new body' }, adapters)).rejects.toThrow(
      UnauthorizedError
    );

    expect(adapters.db.artifactVersions.delete).toHaveBeenCalledWith('version-new');
    expect(adapters.db.artifactContents.delete).toHaveBeenCalledWith('content-new');
    expect(adapters.db.artifactVersions.update).toHaveBeenLastCalledWith({ id: 'version-prev', isActive: true });
  });
});
