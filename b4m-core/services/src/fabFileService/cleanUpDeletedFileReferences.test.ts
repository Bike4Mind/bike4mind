import { describe, it, expect, vi } from 'vitest';
import {
  cleanUpDeletedFileReferences,
  mergeDeletedFileReferences,
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
    order,
    overlapped: () => overlapped,
  };
};

describe('cleanUpDeletedFileReferences', () => {
  it('runs the system-file and project writes one after the other, never in parallel', async () => {
    const db = makeDb();

    await cleanUpDeletedFileReferences(
      { fileIds: ['f1'], systemFileUserIds: ['u1'], projectUserIds: ['u1'] },
      db,
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

describe('mergeDeletedFileReferences', () => {
  it('unions each list across a batch without duplicates', () => {
    expect(
      mergeDeletedFileReferences([
        { fileIds: ['f1'], systemFileUserIds: ['owner', 'r1'], projectUserIds: ['owner', 'r1'] },
        { fileIds: ['f2'], systemFileUserIds: ['owner'], projectUserIds: [] },
      ])
    ).toEqual({ fileIds: ['f1', 'f2'], systemFileUserIds: ['owner', 'r1'], projectUserIds: ['owner', 'r1'] });
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
