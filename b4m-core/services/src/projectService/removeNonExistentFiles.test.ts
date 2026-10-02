import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IUserDocument, Permission } from '@bike4mind/common';
import { removeNonExistentFiles } from './removeNonExistentFiles';

describe('projectService - removeNonExistentFiles (narrowed writes)', () => {
  const OWNER_ID = 'owner-1';
  const PROJECT_ID = 'project-1';

  let db: any;
  let project: any;
  let files: any[];

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

  it('writes only the changed file and a narrowed project partial', async () => {
    await removeNonExistentFiles(OWNER_ID, { projectId: PROJECT_ID }, { db });

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

  it('does not write a file that has no grant from this project', async () => {
    await removeNonExistentFiles(OWNER_ID, { projectId: PROJECT_ID }, { db });

    const writtenIds = db.fabFiles.update.mock.calls.map((c: any[]) => c[0].id);
    expect(writtenIds).not.toContain('f-live-nogrant');
  });
});
