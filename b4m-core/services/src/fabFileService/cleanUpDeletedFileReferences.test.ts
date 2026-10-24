import { describe, it, expect, vi } from 'vitest';
import {
  cleanUpDeletedFileReferences,
  deletedFileReferences,
  groupDeletedFileReferences,
  referenceHolderIds,
} from './cleanUpDeletedFileReferences';

const logger = { warn: vi.fn() } as never;

const makeDb = () => {
  const order: string[] = [];
  let inFlight = 0;
  let overlapped = false;
  const track = (name: string) =>
    vi.fn(async () => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await new Promise(resolve => setTimeout(resolve, 1));
      order.push(name);
      inFlight -= 1;
    });
  return {
    users: { pullSystemFilesForUsers: track('users') },
    projects: { pullFileReferences: track('projects') },
    sessions: { pullKnowledgeIdsForUsers: track('sessions') },
    order,
    overlapped: () => overlapped,
  };
};

describe('cleanUpDeletedFileReferences', () => {
  it('runs the system-file and project writes one after the other, never in parallel', async () => {
    const db = makeDb();

    await cleanUpDeletedFileReferences(
      { fileIds: ['f1'], systemFileUserIds: ['u1'], projectUserIds: ['u1'] },
      { users: db.users, projects: db.projects },
      logger
    );

    expect(db.order).toEqual(['users', 'projects']);
    expect(db.overlapped()).toBe(false);
    expect(db.users.pullSystemFilesForUsers).toHaveBeenCalledWith(['u1'], ['f1']);
    expect(db.projects.pullFileReferences).toHaveBeenCalledWith(['f1'], { userIds: ['u1'] });
  });

  it('still unlinks projects when the system-file write fails, and never throws', async () => {
    const db = makeDb();
    db.users.pullSystemFilesForUsers.mockRejectedValueOnce(new Error('write failed'));

    await expect(
      cleanUpDeletedFileReferences({ fileIds: ['f1'], systemFileUserIds: ['u1'], projectUserIds: ['u1'] }, db, logger)
    ).resolves.toBeUndefined();
    expect(db.projects.pullFileReferences).toHaveBeenCalled();
  });

  it('still unlinks system files when the project write fails, and never throws', async () => {
    const db = makeDb();
    db.projects.pullFileReferences.mockRejectedValueOnce(new Error('write failed'));

    await expect(
      cleanUpDeletedFileReferences({ fileIds: ['f1'], systemFileUserIds: ['u1'], projectUserIds: ['u1'] }, db, logger)
    ).resolves.toBeUndefined();
    expect(db.users.pullSystemFilesForUsers).toHaveBeenCalledWith(['u1'], ['f1']);
  });

  it('unlinks session knowledge ids when the caller wires the sessions arm, before the other writes', async () => {
    const db = makeDb();

    await cleanUpDeletedFileReferences(
      { fileIds: ['f1'], systemFileUserIds: ['u1'], projectUserIds: ['u1'] },
      db,
      logger
    );

    expect(db.order).toEqual(['sessions', 'users', 'projects']);
    expect(db.sessions.pullKnowledgeIdsForUsers).toHaveBeenCalledWith(['u1'], ['f1']);
  });

  it('leaves sessions alone when the caller does not wire them', async () => {
    const db = makeDb();

    await cleanUpDeletedFileReferences(
      { fileIds: ['f1'], systemFileUserIds: ['u1'], projectUserIds: ['u1'] },
      { users: db.users, projects: db.projects },
      logger
    );

    expect(db.sessions.pullKnowledgeIdsForUsers).not.toHaveBeenCalled();
  });

  it('keeps unlinking system files and projects when the session write fails', async () => {
    const db = makeDb();
    db.sessions.pullKnowledgeIdsForUsers.mockRejectedValueOnce(new Error('write failed'));

    await expect(
      cleanUpDeletedFileReferences({ fileIds: ['f1'], systemFileUserIds: ['u1'], projectUserIds: ['u1'] }, db, logger)
    ).resolves.toBeUndefined();
    expect(db.users.pullSystemFilesForUsers).toHaveBeenCalled();
    expect(db.projects.pullFileReferences).toHaveBeenCalled();
  });

  it('touches no project when no project users are named (an unshare)', async () => {
    const db = makeDb();

    await cleanUpDeletedFileReferences({ fileIds: ['f1'], systemFileUserIds: ['u1'], projectUserIds: [] }, db, logger);

    expect(db.users.pullSystemFilesForUsers).toHaveBeenCalledWith(['u1'], ['f1']);
    expect(db.projects.pullFileReferences).not.toHaveBeenCalled();
  });

  it('does nothing for an empty file list', async () => {
    const db = makeDb();

    await cleanUpDeletedFileReferences({ fileIds: [], systemFileUserIds: ['u1'], projectUserIds: ['u1'] }, db, logger);

    expect(db.users.pullSystemFilesForUsers).not.toHaveBeenCalled();
    expect(db.projects.pullFileReferences).not.toHaveBeenCalled();
  });
});

describe('groupDeletedFileReferences', () => {
  it('keeps rows with different holders apart instead of pairing one file with another file recipients', () => {
    expect(
      groupDeletedFileReferences([
        { fileIds: ['deleted'], systemFileUserIds: ['owner', 'r1'], projectUserIds: ['owner', 'r1'] },
        { fileIds: ['unshared'], systemFileUserIds: ['owner'], projectUserIds: [] },
      ])
    ).toEqual([
      { fileIds: ['deleted'], systemFileUserIds: ['owner', 'r1'], projectUserIds: ['owner', 'r1'] },
      { fileIds: ['unshared'], systemFileUserIds: ['owner'], projectUserIds: [] },
    ]);
  });

  it('merges files that share the exact holder set, regardless of the order their holders arrived in', () => {
    expect(
      groupDeletedFileReferences([
        { fileIds: ['f1'], systemFileUserIds: ['owner', 'r1'], projectUserIds: ['owner'] },
        { fileIds: ['f2'], systemFileUserIds: ['r1', 'owner'], projectUserIds: ['owner'] },
      ])
    ).toEqual([{ fileIds: ['f1', 'f2'], systemFileUserIds: ['owner', 'r1'], projectUserIds: ['owner'] }]);
  });

  it('returns nothing for an empty batch', () => {
    expect(groupDeletedFileReferences([])).toEqual([]);
  });
});

describe('deletedFileReferences', () => {
  it('scopes one deleted file to every holder, deduped', () => {
    expect(
      deletedFileReferences({ id: 'f1', userId: 'owner', users: [{ userId: 'r1' }, { userId: 'owner' }, {}] })
    ).toEqual({ fileIds: ['f1'], systemFileUserIds: ['owner', 'r1'], projectUserIds: ['owner', 'r1'] });
  });
});

describe('referenceHolderIds', () => {
  it('is the owner plus direct-share recipients, deduped, skipping missing ids', () => {
    expect(referenceHolderIds({ userId: 'owner', users: [{ userId: 'r1' }, { userId: 'owner' }, {}] })).toEqual([
      'owner',
      'r1',
    ]);
  });
});
