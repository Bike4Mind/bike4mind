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
          update: vi.fn().mockImplementation(async (data: any) => ({ ...artifact, ...data })),
        },
        artifactContents: {
          createOrUpdate: vi.fn().mockResolvedValue({ _id: 'content-new' }),
          findByArtifactId: vi.fn().mockResolvedValue([]),
        },
        artifactVersions: {
          findByArtifactId: vi.fn().mockResolvedValue([]),
          findOne: vi.fn().mockResolvedValue(null),
          createOrUpdate: vi.fn().mockResolvedValue({ _id: 'version-new' }),
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
    expect(adapters.db.artifacts.update).not.toHaveBeenCalled();
  });

  it('denies a non-owner writer that tries to change visibility', async () => {
    await expect(update(sharedWriterId, { id: 'artifact-1', visibility: 'public' }, adapters)).rejects.toThrow(
      UnauthorizedError
    );
    expect(adapters.db.artifacts.update).not.toHaveBeenCalled();
  });

  it('lets a non-owner writer edit content', async () => {
    await update(sharedWriterId, { id: 'artifact-1', content: 'new body' }, adapters);
    expect(adapters.db.artifacts.update).toHaveBeenCalled();
  });

  it('lets the owner change permissions and visibility', async () => {
    await update(ownerId, { id: 'artifact-1', visibility: 'public', permissions: { isPublic: true } }, adapters);
    expect(adapters.db.artifacts.update).toHaveBeenCalledWith(
      expect.objectContaining({
        visibility: 'public',
        permissions: expect.objectContaining({ isPublic: true }),
      })
    );
  });
});
