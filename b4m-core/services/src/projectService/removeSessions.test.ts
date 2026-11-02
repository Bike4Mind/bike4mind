import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import { ForbiddenError, IUserDocument, Permission } from '@bike4mind/common';
import { removeSessions } from './removeSessions';

type Grant = { userId: string; permissions: Permission[]; projectId?: string };

describe('projectService - removeSessions (narrowed writes)', () => {
  const OWNER_ID = 'owner-1';
  const PROJECT_ID = 'project-1';
  const SESSION_A = '67dbe18a7f9cf1fa5d968601';
  const SESSION_B = '67dbe18a7f9cf1fa5d968602';
  const SESSION_KEPT = '67dbe18a7f9cf1fa5d968603';

  let db: {
    users: { findById: Mock };
    projects: { shareable: { findAccessibleById: Mock }; update: Mock };
    sessions: { shareable: { findAllAccessibleByIds: Mock; updateUserShares: Mock }; update: Mock };
  };
  let project: { id: string; userId: string; sessionIds: string[] };
  let sessions: { id: string; userId: string; users: Grant[] }[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    project = { id: PROJECT_ID, userId: OWNER_ID, sessionIds: [SESSION_A, SESSION_B, SESSION_KEPT] };
    sessions = [
      {
        id: SESSION_A,
        userId: OWNER_ID,
        users: [
          { userId: 'member-1', permissions: [Permission.read], projectId: PROJECT_ID },
          { userId: 'member-2', permissions: [Permission.read], projectId: 'other-project' },
        ],
      },
      {
        id: SESSION_B,
        userId: OWNER_ID,
        users: [{ userId: 'member-3', permissions: [Permission.read], projectId: PROJECT_ID }],
      },
    ];

    db = {
      users: { findById: vi.fn(async (id: string) => ({ id }) as IUserDocument) },
      projects: {
        shareable: { findAccessibleById: vi.fn(async () => project) },
        update: vi.fn(async () => project),
      },
      sessions: {
        shareable: { findAllAccessibleByIds: vi.fn(async () => sessions), updateUserShares: vi.fn() },
        update: vi.fn(async () => undefined),
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with a ForbiddenError when a non-owner removes a session they do not own', async () => {
    project.userId = 'someone-else';
    sessions[0].userId = 'someone-else';

    await expect(
      removeSessions(OWNER_ID, { projectId: PROJECT_ID, sessionIds: [SESSION_A, SESSION_B] }, {
        db,
      } as unknown as Parameters<typeof removeSessions>[2])
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.sessions.shareable.updateUserShares).not.toHaveBeenCalled();
  });

  it('drops the project grants from each session and writes a narrowed project partial', async () => {
    await removeSessions(
      OWNER_ID,
      { projectId: PROJECT_ID, sessionIds: [SESSION_A, SESSION_B] },
      // The stub db implements only the repository methods this service calls.
      { db } as unknown as Parameters<typeof removeSessions>[2]
    );

    expect(db.sessions.update).not.toHaveBeenCalled();
    expect(db.sessions.shareable.updateUserShares.mock.calls).toStrictEqual([
      [SESSION_A, { remove: { projectId: PROJECT_ID } }],
      [SESSION_B, { remove: { projectId: PROJECT_ID } }],
    ]);

    expect(db.projects.update).toHaveBeenCalledTimes(1);
    expect(db.projects.update.mock.calls[0][0]).toStrictEqual({
      id: PROJECT_ID,
      sessionIds: [SESSION_KEPT],
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
  });
});
