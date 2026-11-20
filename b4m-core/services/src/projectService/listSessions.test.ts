import { describe, it, expect, vi } from 'vitest';
import { NotFoundError, type IUserDocument } from '@bike4mind/common';
import { listSessions } from './listSessions';

describe('projectService - listSessions', () => {
  const makeDb = (project: { sessionIds: string[] } | null) => ({
    users: { findById: vi.fn(async (id: string) => ({ id }) as IUserDocument) },
    projects: { shareable: { findAccessibleById: vi.fn(async () => project) } },
    sessions: { findAllByIds: vi.fn(async (ids: string[]) => ids.map(id => ({ id }))) },
  });
  const run = (db: ReturnType<typeof makeDb>) =>
    listSessions('u1', { projectId: 'p1' }, { db } as unknown as Parameters<typeof listSessions>[2]);

  it('returns the sessions the project groups', async () => {
    const db = makeDb({ sessionIds: ['s1', 's2'] });
    expect(await run(db)).toEqual([{ id: 's1' }, { id: 's2' }]);
  });

  it('answers NotFoundError when the project is not accessible', async () => {
    await expect(run(makeDb(null))).rejects.toBeInstanceOf(NotFoundError);
  });
});
