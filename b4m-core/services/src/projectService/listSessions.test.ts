import { describe, it, expect, vi } from 'vitest';
import { NotFoundError, type IUserDocument } from '@bike4mind/common';
import { listSessions } from './listSessions';

describe('projectService - listSessions', () => {
  const makeDb = (project: { sessionIds: string[] } | null) => ({
    users: { findById: vi.fn(async (id: string) => ({ id }) as IUserDocument) },
    projects: { shareable: { findAccessibleById: vi.fn(async () => project) } },
    sessions: {
      findAllByIds: vi.fn(async (ids: string[]) => ids.map(id => ({ id }))),
      shareable: {
        // Stands in for the read check: 'revoked' is listed in the project but no longer readable.
        findAllAccessibleByIds: vi.fn(async (_user: IUserDocument, ids: string[]) =>
          ids.filter(id => id !== 'revoked').map(id => ({ id }))
        ),
      },
    },
  });
  const run = (db: ReturnType<typeof makeDb>) =>
    listSessions('u1', { projectId: 'p1' }, { db } as unknown as Parameters<typeof listSessions>[2]);

  it('returns the sessions the project groups', async () => {
    const db = makeDb({ sessionIds: ['s1', 's2'] });
    expect(await run(db)).toEqual([{ id: 's1' }, { id: 's2' }]);
  });

  it('omits a session the caller can no longer read', async () => {
    const db = makeDb({ sessionIds: ['s1', 'revoked'] });
    expect(await run(db)).toEqual([{ id: 's1' }]);
    expect(db.sessions.shareable.findAllAccessibleByIds).toHaveBeenCalledWith({ id: 'u1' }, ['s1', 'revoked']);
    expect(db.sessions.findAllByIds).not.toHaveBeenCalled();
  });

  it('answers NotFoundError when the project is not accessible', async () => {
    await expect(run(makeDb(null))).rejects.toBeInstanceOf(NotFoundError);
  });
});
