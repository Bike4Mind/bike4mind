import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanUpRevokedFileReferences, projectRevokeCleanupTargets } from './cleanUpRevokedFileReferences';

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), log: vi.fn() } as never;

const setup = () => {
  const db = {
    users: {
      findById: vi.fn(async (id: string) => ({ id, groups: ['g1'] })),
      pullSystemFilesForUsers: vi.fn(),
    },
    fabFiles: { findAccessibleInIds: vi.fn().mockResolvedValue([]) },
    sessions: { pullKnowledgeIdsForUsers: vi.fn() },
  };
  const resolveAttachmentLakeAccess = vi.fn().mockResolvedValue({ dataLakeTags: ['datalake:acme:docs'] });
  return { db, resolveAttachmentLakeAccess, adapters: { db, resolveAttachmentLakeAccess, logger } as never };
};

describe('cleanUpRevokedFileReferences', () => {
  beforeEach(() => vi.clearAllMocks());

  it('drops only the files a target can no longer read from their system files and own sessions', async () => {
    const { db, adapters } = setup();
    db.fabFiles.findAccessibleInIds.mockResolvedValue([{ id: 'f2' }]);

    await cleanUpRevokedFileReferences([{ userId: 'recipient', fileIds: ['f1', 'f2'] }], adapters);

    expect(db.fabFiles.findAccessibleInIds).toHaveBeenCalledWith(
      ['f1', 'f2'],
      { userId: 'recipient', userGroups: ['g1'] },
      { dataLakeTags: ['datalake:acme:docs'] }
    );
    expect(db.users.pullSystemFilesForUsers).toHaveBeenCalledWith(['recipient'], ['f1']);
    expect(db.sessions.pullKnowledgeIdsForUsers).toHaveBeenCalledWith(['recipient'], ['f1']);
  });

  it('checks each target against its own access', async () => {
    const { db, adapters } = setup();
    db.fabFiles.findAccessibleInIds.mockImplementation(async (_ids: string[], access: { userId: string }) =>
      access.userId === 'keeps' ? [{ id: 'f1' }] : []
    );

    await cleanUpRevokedFileReferences(
      [
        { userId: 'keeps', fileIds: ['f1'] },
        { userId: 'loses', fileIds: ['f1'] },
      ],
      adapters
    );

    expect(db.users.pullSystemFilesForUsers).toHaveBeenCalledTimes(1);
    expect(db.users.pullSystemFilesForUsers).toHaveBeenCalledWith(['loses'], ['f1']);
  });

  it('keeps everything while another route (group, global read, lake) still reaches the files', async () => {
    const { db, adapters } = setup();
    db.fabFiles.findAccessibleInIds.mockResolvedValue([{ id: 'f1' }]);

    await cleanUpRevokedFileReferences([{ userId: 'recipient', fileIds: ['f1'] }], adapters);

    expect(db.users.pullSystemFilesForUsers).not.toHaveBeenCalled();
    expect(db.sessions.pullKnowledgeIdsForUsers).not.toHaveBeenCalled();
  });

  it('skips a target whose lake access could not be resolved, and still checks the others', async () => {
    const { db, resolveAttachmentLakeAccess, adapters } = setup();
    resolveAttachmentLakeAccess.mockImplementation(async (user: { id: string }) =>
      user.id === 'outage' ? { resolutionFailed: true } : {}
    );

    await cleanUpRevokedFileReferences(
      [
        { userId: 'outage', fileIds: ['f1'] },
        { userId: 'fine', fileIds: ['f1'] },
      ],
      adapters
    );

    expect(db.users.pullSystemFilesForUsers).toHaveBeenCalledTimes(1);
    expect(db.users.pullSystemFilesForUsers).toHaveBeenCalledWith(['fine'], ['f1']);
  });

  it('keeps the references and does not throw when the access check fails', async () => {
    const { db, adapters } = setup();
    db.fabFiles.findAccessibleInIds.mockRejectedValue(new Error('mongo blip'));

    await expect(
      cleanUpRevokedFileReferences([{ userId: 'recipient', fileIds: ['f1'] }], adapters)
    ).resolves.toBeUndefined();
    expect(db.users.pullSystemFilesForUsers).not.toHaveBeenCalled();
  });

  it('skips unknown users and empty file lists', async () => {
    const { db, adapters } = setup();
    db.users.findById.mockResolvedValueOnce(null as never);

    await cleanUpRevokedFileReferences(
      [
        { userId: 'ghost', fileIds: ['f1'] },
        { userId: 'nobody', fileIds: [] },
      ],
      adapters
    );

    expect(db.fabFiles.findAccessibleInIds).not.toHaveBeenCalled();
    expect(db.users.pullSystemFilesForUsers).not.toHaveBeenCalled();
  });
});

describe('projectRevokeCleanupTargets', () => {
  const project = {
    id: 'p1',
    userId: 'owner',
    users: [{ userId: 'leaver' }, { userId: 'stayer' }],
    fileIds: ['owner-file', 'leaver-file', 'stayer-file'],
  };
  const files = [
    { id: 'owner-file', userId: 'owner' },
    { id: 'leaver-file', userId: 'leaver' },
    { id: 'stayer-file', userId: 'stayer' },
  ];
  const db = () => ({
    projects: { findById: vi.fn().mockResolvedValue(project) },
    fabFiles: { findAllByIds: vi.fn().mockResolvedValue(files) },
  });

  it('checks every project file for the leaver, and the leaver-owned files for everyone else', async () => {
    expect(await projectRevokeCleanupTargets('p1', 'leaver', db() as never)).toEqual([
      { userId: 'leaver', fileIds: ['owner-file', 'leaver-file', 'stayer-file'] },
      { userId: 'owner', fileIds: ['leaver-file'] },
      { userId: 'stayer', fileIds: ['leaver-file'] },
    ]);
  });

  it('checks every file for every participant when the project is deleted', async () => {
    const targets = await projectRevokeCleanupTargets('p1', undefined, db() as never);
    expect(targets.map(t => t.userId)).toEqual(['owner', 'leaver', 'stayer']);
    expect(targets.every(t => t.fileIds.length === 3)).toBe(true);
  });

  it('returns nothing for an unknown project', async () => {
    const missing = { ...db(), projects: { findById: vi.fn().mockResolvedValue(null) } };
    expect(await projectRevokeCleanupTargets('nope', 'leaver', missing as never)).toEqual([]);
  });
});
