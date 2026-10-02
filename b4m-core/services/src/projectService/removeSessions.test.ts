import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IUserDocument, Permission } from '@bike4mind/common';
import { removeSessions } from './removeSessions';

describe('projectService - removeSessions (narrowed writes)', () => {
  const OWNER_ID = 'owner-1';
  const PROJECT_ID = 'project-1';
  const SESSION_A = '67dbe18a7f9cf1fa5d968601';
  const SESSION_B = '67dbe18a7f9cf1fa5d968602';
  const SESSION_KEPT = '67dbe18a7f9cf1fa5d968603';

  let db: any;
  let project: any;
  let sessions: any[];

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
    await removeSessions(OWNER_ID, { projectId: PROJECT_ID, sessionIds: [SESSION_A, SESSION_B] }, { db });

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
});
