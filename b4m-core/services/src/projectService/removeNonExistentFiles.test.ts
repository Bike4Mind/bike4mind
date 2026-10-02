import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import { IUserDocument, Permission } from '@bike4mind/common';
import { removeNonExistentFiles } from './removeNonExistentFiles';

type Grant = { userId: string; permissions: Permission[]; projectId?: string };

describe('projectService - removeNonExistentFiles (narrowed writes)', () => {
  const OWNER_ID = 'owner-1';
  const PROJECT_ID = 'project-1';

  let db: {
    users: { findById: Mock };
    projects: { shareable: { findAccessibleById: Mock }; update: Mock };
    fabFiles: { findAllByIds: Mock; update: Mock };
  };
  let project: { id: string; userId: string; fileIds: string[] };
  let files: { id: string; users: Grant[] }[];

  // The stub db implements only the repository methods this service calls.
  const run = () =>
    removeNonExistentFiles(OWNER_ID, { projectId: PROJECT_ID }, { db } as unknown as Parameters<
      typeof removeNonExistentFiles
    >[2]);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    project = { id: PROJECT_ID, userId: OWNER_ID, fileIds: ['f-live-granted', 'f-live-nogrant', 'f-gone'] };
    files = [
      {
        id: 'f-live-granted',
        users: [
          { userId: 'member-1', permissions: [Permission.read], projectId: PROJECT_ID },
          { userId: 'member-2', permissions: [Permission.read], projectId: 'other-project' },
          { userId: 'member-3', permissions: [Permission.read] },
        ],
      },
      { id: 'f-live-nogrant', users: [{ userId: 'member-2', permissions: [Permission.read], projectId: 'other' }] },
    ];

    db = {
      users: { findById: vi.fn(async (id: string) => ({ id }) as IUserDocument) },
      projects: {
        shareable: { findAccessibleById: vi.fn(async () => project) },
        update: vi.fn(async () => project),
      },
      fabFiles: {
        findAllByIds: vi.fn(async () => files),
        update: vi.fn(async () => undefined),
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes only the file with a project grant and a narrowed project partial', async () => {
    await run();

    expect(db.fabFiles.update).toHaveBeenCalledTimes(1);
    expect(db.fabFiles.update.mock.calls[0][0]).toStrictEqual({
      id: 'f-live-granted',
      users: [
        { userId: 'member-2', permissions: [Permission.read], projectId: 'other-project' },
        { userId: 'member-3', permissions: [Permission.read] },
      ],
    });

    expect(db.projects.update).toHaveBeenCalledTimes(1);
    expect(db.projects.update.mock.calls[0][0]).toStrictEqual({
      id: PROJECT_ID,
      fileIds: ['f-live-granted', 'f-live-nogrant'],
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
  });

  it('writes nothing when the project has no files', async () => {
    project.fileIds = [];

    await run();

    expect(db.fabFiles.findAllByIds).not.toHaveBeenCalled();
    expect(db.fabFiles.update).not.toHaveBeenCalled();
    expect(db.projects.update).not.toHaveBeenCalled();
  });

  it('writes nothing when every file still exists', async () => {
    project.fileIds = ['f-live-granted', 'f-live-nogrant'];

    await run();

    expect(db.fabFiles.update).not.toHaveBeenCalled();
    expect(db.projects.update).not.toHaveBeenCalled();
  });
});
