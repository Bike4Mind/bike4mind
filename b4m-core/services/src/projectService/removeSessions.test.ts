import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import { ForbiddenError, IUserDocument, NotFoundError, Permission } from '@bike4mind/common';
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
    sessions: { shareable: { findAllAccessibleByIds: Mock }; update: Mock };
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
        shareable: { findAllAccessibleByIds: vi.fn(async () => sessions) },
        update: vi.fn(async () => undefined),
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes narrowed per-session and project partials', async () => {
    await removeSessions(
      OWNER_ID,
      { projectId: PROJECT_ID, sessionIds: [SESSION_A, SESSION_B] },
      // The stub db implements only the repository methods this service calls.
      { db } as unknown as Parameters<typeof removeSessions>[2]
    );

    expect(db.sessions.update).toHaveBeenCalledTimes(2);
    expect(db.sessions.update.mock.calls[0][0]).toStrictEqual({
      id: SESSION_A,
      users: [{ userId: 'member-2', permissions: [Permission.read], projectId: 'other-project' }],
    });
    expect(db.sessions.update.mock.calls[1][0]).toStrictEqual({ id: SESSION_B, users: [] });

    expect(db.projects.update).toHaveBeenCalledTimes(1);
    expect(db.projects.update.mock.calls[0][0]).toStrictEqual({
      id: PROJECT_ID,
      sessionIds: [SESSION_KEPT],
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
  });

  const callRemove = (userId: string, sessionIds: string[]) =>
    removeSessions(userId, { projectId: PROJECT_ID, sessionIds }, { db } as unknown as Parameters<
      typeof removeSessions
    >[2]);

  it('answers NotFoundError for an unknown user or an inaccessible project', async () => {
    db.users.findById.mockResolvedValueOnce(null);
    await expect(callRemove(OWNER_ID, [SESSION_A])).rejects.toBeInstanceOf(NotFoundError);

    db.projects.shareable.findAccessibleById.mockResolvedValueOnce(null);
    await expect(callRemove(OWNER_ID, [SESSION_A])).rejects.toBeInstanceOf(NotFoundError);
  });

  it('answers ForbiddenError when a non-owner removes a session they do not own', async () => {
    await expect(callRemove('member-1', [SESSION_A])).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.projects.update).not.toHaveBeenCalled();
  });

  it('lets the owner clear a held id that no longer resolves, such as a deleted session', async () => {
    db.sessions.shareable.findAllAccessibleByIds.mockResolvedValueOnce([]);

    const { removedIds } = await removeSessions(
      OWNER_ID,
      { projectId: PROJECT_ID, sessionIds: [SESSION_KEPT] },
      { db }
    );

    expect(removedIds).toEqual([SESSION_KEPT]);
    expect(db.projects.update).toHaveBeenCalledWith(expect.objectContaining({ sessionIds: [SESSION_A, SESSION_B] }));
  });

  it('still rejects a held id that no longer resolves for a member who is not the owner', async () => {
    db.sessions.shareable.findAllAccessibleByIds.mockResolvedValueOnce([]);

    await expect(
      removeSessions('member-1', { projectId: PROJECT_ID, sessionIds: [SESSION_KEPT] }, { db })
    ).rejects.toThrow('Some sessions are not accessible');
    expect(db.projects.update).not.toHaveBeenCalled();
  });

  it('reports no removed ids when the session is not in the project', async () => {
    project.sessionIds = [SESSION_KEPT];

    const { removedIds } = await removeSessions(OWNER_ID, { projectId: PROJECT_ID, sessionIds: [SESSION_A] }, { db });

    expect(removedIds).toEqual([]);
  });
});
