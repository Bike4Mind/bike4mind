import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanUpRevokedFileReferences } from './cleanUpRevokedFileReferences';

const user = { id: 'recipient', groups: ['g1'] };
const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), log: vi.fn() } as never;

const setup = () => {
  const db = {
    users: { findById: vi.fn().mockResolvedValue(user), pullSystemFilesForUsers: vi.fn() },
    fabFiles: { findAccessibleInIds: vi.fn().mockResolvedValue([]) },
    sessions: { pullKnowledgeIdsForUsers: vi.fn() },
  };
  const resolveAttachmentLakeAccess = vi.fn().mockResolvedValue({ dataLakeTags: ['datalake:acme:docs'] });
  return { db, resolveAttachmentLakeAccess, adapters: { db, resolveAttachmentLakeAccess, logger } as never };
};

describe('cleanUpRevokedFileReferences', () => {
  beforeEach(() => vi.clearAllMocks());

  it("drops the file from the revoked user's system files and own sessions once they cannot read it", async () => {
    const { db, adapters } = setup();

    await cleanUpRevokedFileReferences('f1', 'recipient', adapters);

    expect(db.fabFiles.findAccessibleInIds).toHaveBeenCalledWith(
      ['f1'],
      { userId: 'recipient', userGroups: ['g1'] },
      { dataLakeTags: ['datalake:acme:docs'] }
    );
    expect(db.users.pullSystemFilesForUsers).toHaveBeenCalledWith(['recipient'], ['f1']);
    expect(db.sessions.pullKnowledgeIdsForUsers).toHaveBeenCalledWith(['recipient'], ['f1']);
  });

  it('keeps the references while another route (group, global read, lake) still reaches the file', async () => {
    const { db, adapters } = setup();
    db.fabFiles.findAccessibleInIds.mockResolvedValue([{ id: 'f1' }]);

    await cleanUpRevokedFileReferences('f1', 'recipient', adapters);

    expect(db.users.pullSystemFilesForUsers).not.toHaveBeenCalled();
    expect(db.sessions.pullKnowledgeIdsForUsers).not.toHaveBeenCalled();
  });

  it('keeps the references when lake access could not be resolved', async () => {
    const { db, resolveAttachmentLakeAccess, adapters } = setup();
    resolveAttachmentLakeAccess.mockResolvedValue({ resolutionFailed: true });

    await cleanUpRevokedFileReferences('f1', 'recipient', adapters);

    expect(db.fabFiles.findAccessibleInIds).not.toHaveBeenCalled();
    expect(db.users.pullSystemFilesForUsers).not.toHaveBeenCalled();
  });

  it('keeps the references and does not throw when the access check fails', async () => {
    const { db, adapters } = setup();
    db.fabFiles.findAccessibleInIds.mockRejectedValue(new Error('mongo blip'));

    await expect(cleanUpRevokedFileReferences('f1', 'recipient', adapters)).resolves.toBeUndefined();
    expect(db.users.pullSystemFilesForUsers).not.toHaveBeenCalled();
  });

  it('does nothing for an unknown user', async () => {
    const { db, adapters } = setup();
    db.users.findById.mockResolvedValue(null);

    await cleanUpRevokedFileReferences('f1', 'ghost', adapters);

    expect(db.users.pullSystemFilesForUsers).not.toHaveBeenCalled();
  });
});
