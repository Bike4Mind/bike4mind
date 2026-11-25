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
          claimNextVersionNumber: vi.fn().mockResolvedValue(2),
          seedVersionCounter: vi.fn(),
        },
        artifactContents: {
          create: vi.fn().mockResolvedValue({ _id: 'content-new' }),
          delete: vi.fn(),
          findLatestContent: vi.fn().mockResolvedValue(null),
        },
        artifactVersions: {
          findByArtifactId: vi.fn().mockResolvedValue([]),
          create: vi.fn().mockResolvedValue({ _id: 'version-new', isActive: true }),
          updateMany: vi.fn(),
          count: vi.fn().mockResolvedValue(0),
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
    expect(adapters.db.artifacts.updateWithWriteAccess).toHaveBeenLastCalledWith(
      sharedWriterId,
      expect.objectContaining({ id: 'artifact-1', version: 2, currentVersionId: 'version-new' }),
      { version: { $lt: 2 } }
    );
  });

  it('lets the owner change permissions and visibility', async () => {
    await update(ownerId, { id: 'artifact-1', visibility: 'public', permissions: { isPublic: true } }, adapters);
    expect(adapters.db.artifacts.updateWithWriteAccess).toHaveBeenCalledWith(
      ownerId,
      expect.objectContaining({
        visibility: 'public',
        permissions: expect.objectContaining({ isPublic: true }),
      }),
      undefined
    );
  });
});

describe('artifactService - update (write-time re-check)', () => {
  const writerId = 'writer-id';
  let adapters: any;
  let artifact: any;

  beforeEach(() => {
    artifact = {
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
          claimNextVersionNumber: vi.fn().mockResolvedValue(2),
          seedVersionCounter: vi.fn(),
        },
        artifactContents: {
          create: vi.fn().mockResolvedValue({ _id: 'content-new' }),
          delete: vi.fn(),
          findLatestContent: vi.fn().mockResolvedValue(null),
        },
        artifactVersions: {
          findByArtifactId: vi.fn().mockResolvedValue([]),
          create: vi.fn().mockResolvedValue({ _id: 'version-new', isActive: true }),
          updateMany: vi.fn(),
          count: vi.fn().mockResolvedValue(0),
          update: vi.fn(),
          delete: vi.fn(),
        },
      },
    };
  });

  const gate = () => adapters.db.artifacts.updateWithWriteAccess;

  it('writes no version or content row when the claim matches nothing', async () => {
    adapters.db.artifacts.claimNextVersionNumber.mockResolvedValue(null);

    await expect(
      update(writerId, { id: 'artifact-1', title: 'Renamed', content: 'new body' }, adapters)
    ).rejects.toThrow(UnauthorizedError);

    expect(adapters.db.artifacts.seedVersionCounter).toHaveBeenCalledTimes(1);
    expect(gate()).not.toHaveBeenCalled();
    expect(adapters.db.artifactContents.create).not.toHaveBeenCalled();
    expect(adapters.db.artifactVersions.create).not.toHaveBeenCalled();
    expect(adapters.db.artifactVersions.update).not.toHaveBeenCalled();
  });

  it('seeds the counter from the highest existing version, then claims again', async () => {
    artifact.version = 5;
    adapters.db.artifacts.claimNextVersionNumber.mockResolvedValueOnce(null).mockResolvedValueOnce(8);
    adapters.db.artifactVersions.findByArtifactId.mockResolvedValue([{ version: 7 }, { version: 3 }]);

    await update(writerId, { id: 'artifact-1', content: 'new body' }, adapters);

    expect(adapters.db.artifacts.seedVersionCounter).toHaveBeenCalledWith(writerId, 'artifact-1', 7);
    expect(adapters.db.artifactVersions.create).toHaveBeenCalledWith(expect.objectContaining({ version: 8 }));
    expect(adapters.db.artifactContents.create).toHaveBeenCalledWith(expect.objectContaining({ version: 8 }));
  });

  it('writes no metadata when creating the content row fails', async () => {
    adapters.db.artifactContents.create.mockRejectedValueOnce(new Error('write failed'));

    await expect(
      update(writerId, { id: 'artifact-1', title: 'Renamed', content: 'new body' }, adapters)
    ).rejects.toThrow('write failed');

    expect(gate()).not.toHaveBeenCalled();
  });

  it('deactivates lower versions and keeps the new row active when it is the highest', async () => {
    await update(writerId, { id: 'artifact-1', content: 'new body' }, adapters);

    expect(adapters.db.artifactVersions.updateMany).toHaveBeenCalledWith(
      { artifactId: 'artifact-1', version: { $lt: 2 }, isActive: true },
      { isActive: false },
      { runValidators: true }
    );
    expect(adapters.db.artifactVersions.update).not.toHaveBeenCalled();
  });

  it('deactivates its own row when a higher version is already active', async () => {
    adapters.db.artifactVersions.count.mockResolvedValueOnce(1);

    const result = await update(writerId, { id: 'artifact-1', content: 'new body' }, adapters);

    expect(adapters.db.artifactVersions.update).toHaveBeenCalledWith({ id: 'version-new', isActive: false });
    expect(result.version?.isActive).toBe(false);
  });

  it('keeps its row but leaves the pointer alone when a higher version already moved it', async () => {
    gate().mockResolvedValueOnce(null);

    const result = await update(writerId, { id: 'artifact-1', title: 'Renamed', content: 'new body' }, adapters);

    expect(result.version?._id).toBe('version-new');
    expect(adapters.db.artifactVersions.delete).not.toHaveBeenCalled();
    expect(adapters.db.artifactContents.delete).not.toHaveBeenCalled();
    expect(gate()).toHaveBeenCalledTimes(2);
    const retry = gate().mock.calls[1];
    expect(retry).toHaveLength(2);
    expect(retry[1]).toEqual({ id: 'artifact-1', updatedAt: expect.any(Date), title: 'Renamed' });
  });

  it('writes metadata and the version pointer together in one gated write', async () => {
    await update(writerId, { id: 'artifact-1', title: 'Renamed', content: 'new body' }, adapters);

    expect(gate()).toHaveBeenCalledTimes(1);
    expect(gate()).toHaveBeenCalledWith(
      writerId,
      expect.objectContaining({
        id: 'artifact-1',
        title: 'Renamed',
        version: 2,
        currentVersionId: 'version-new',
        contentHash: expect.any(String),
        contentSize: expect.any(Number),
      }),
      { version: { $lt: 2 } }
    );
  });

  it('copies the latest content into a version created without content', async () => {
    adapters.db.artifactContents.findLatestContent.mockResolvedValueOnce({
      version: 3,
      content: 'v3 body',
      contentHash: 'h3',
      contentSize: 7,
      mimeType: 'text/plain',
      encoding: 'utf-8',
    });

    await update(writerId, { id: 'artifact-1', createNewVersion: true, changeDescription: 'marker only' }, adapters);

    expect(adapters.db.artifactContents.findLatestContent).toHaveBeenCalledWith('artifact-1');
    expect(adapters.db.artifactContents.create).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'v3 body', contentHash: 'h3' })
    );
  });

  it('stamps the version tag on the new version row when content changes', async () => {
    await update(writerId, { id: 'artifact-1', content: 'new body', versionTag: 'v2' }, adapters);

    expect(adapters.db.artifactVersions.create).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2, versionTag: 'v2' })
    );
  });

  it('stamps the version tag on a forced version with unchanged content', async () => {
    await update(
      writerId,
      { id: 'artifact-1', content: 'same body', createNewVersion: true, versionTag: 'v2' },
      adapters
    );

    expect(adapters.db.artifactVersions.create).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2, versionTag: 'v2' })
    );
  });

  it('leaves versionTag off the version row when none is given', async () => {
    await update(writerId, { id: 'artifact-1', content: 'new body' }, adapters);

    expect(adapters.db.artifactVersions.create.mock.calls[0][0]).not.toHaveProperty('versionTag');
  });

  it('clears the artifact version tag on a forced version created without one', async () => {
    await update(writerId, { id: 'artifact-1', content: 'new body', createNewVersion: true }, adapters);

    expect(gate()).toHaveBeenCalledWith(writerId, expect.objectContaining({ version: 2, versionTag: null }), {
      version: { $lt: 2 },
    });
  });

  it('keeps the artifact version tag on a plain content edit without one', async () => {
    await update(writerId, { id: 'artifact-1', content: 'new body' }, adapters);

    expect(gate().mock.calls[0][1]).not.toHaveProperty('versionTag');
  });

  it('makes a single gated write for a metadata-only update', async () => {
    await update(writerId, { id: 'artifact-1', title: 'Renamed' }, adapters);

    expect(gate()).toHaveBeenCalledTimes(1);
    expect(gate()).toHaveBeenCalledWith(
      writerId,
      expect.objectContaining({ id: 'artifact-1', title: 'Renamed' }),
      undefined
    );
    expect(adapters.db.artifactVersions.create).not.toHaveBeenCalled();
  });

  it('rolls the new rows back and reactivates the highest remaining version when both final writes are refused', async () => {
    gate().mockResolvedValue(null);
    adapters.db.artifactVersions.findByArtifactId.mockResolvedValue([{ _id: 'version-prev', version: 1 }]);

    await expect(
      update(writerId, { id: 'artifact-1', title: 'Renamed', content: 'new body' }, adapters)
    ).rejects.toThrow(UnauthorizedError);

    expect(adapters.db.artifactVersions.delete).toHaveBeenCalledWith('version-new');
    expect(adapters.db.artifactContents.delete).toHaveBeenCalledWith('content-new');
    expect(adapters.db.artifactVersions.update).toHaveBeenLastCalledWith({ id: 'version-prev', isActive: true });
  });

  it('does not reactivate a version when another row is already active', async () => {
    gate().mockResolvedValue(null);
    adapters.db.artifactVersions.count.mockResolvedValue(1);

    await expect(update(writerId, { id: 'artifact-1', content: 'new body' }, adapters)).rejects.toThrow(
      UnauthorizedError
    );

    expect(adapters.db.artifactVersions.delete).toHaveBeenCalledWith('version-new');
    expect(adapters.db.artifactVersions.update).not.toHaveBeenCalledWith({ id: 'version-prev', isActive: true });
  });

  it('still refuses, and runs the remaining steps, when a rollback step throws', async () => {
    gate().mockResolvedValue(null);
    adapters.db.artifactVersions.delete.mockRejectedValueOnce(new Error('delete failed'));

    await expect(update(writerId, { id: 'artifact-1', content: 'new body' }, adapters)).rejects.toThrow(
      UnauthorizedError
    );

    expect(adapters.db.artifactContents.delete).toHaveBeenCalledWith('content-new');
  });
});
