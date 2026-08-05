import { describe, it, expect, vi } from 'vitest';
import { createUserMementoMemoryStore, type UserMementoReader } from './userMementoMemoryStore';

const mementos = () => [
  {
    _id: 'm1',
    summary: 'Erik lives in Austin.',
    tier: 'hot',
    sessionId: 's1',
    lastAccessedAt: new Date('2026-07-10T00:00:00Z'),
  },
];
const reader = (): UserMementoReader => ({ findByUserId: async userId => (userId === 'u1' ? mementos() : []) });

describe('createUserMementoMemoryStore', () => {
  it("returns the requesting user's own memory", async () => {
    const store = createUserMementoMemoryStore({ mementos: reader(), ownerUserId: 'u1' });
    const p = await store.readProfile({ kind: 'user', id: 'u1' });
    expect(p?.principal).toEqual({ kind: 'user', id: 'u1' });
    expect(p?.beliefs[0]).toMatchObject({ fact: 'Erik lives in Austin.', confidence: 0.9 });
  });

  it("returns null when reading another user's memory (scope isolation)", async () => {
    const store = createUserMementoMemoryStore({ mementos: reader(), ownerUserId: 'u1' });
    expect(await store.readProfile({ kind: 'user', id: 'someone-else' })).toBeNull();
  });

  it('returns null for non-user principals', async () => {
    const store = createUserMementoMemoryStore({ mementos: reader(), ownerUserId: 'u1' });
    expect(await store.readProfile({ kind: 'agent', id: 'a1' })).toBeNull();
  });
});

/**
 * The profile read is paged. A profile has to end up holding every belief, so this is not a coverage
 * bound - it keeps one page of HYDRATED Mongoose documents live instead of all of them, which is the
 * expensive half (internals plus an embedding each) on the chat's critical path.
 */
describe('createUserMementoMemoryStore pages its profile read', () => {
  const PAGE_SIZE = 200;

  /** Real keyset arithmetic; a page-keyed stub could not observe a wrong cursor. */
  const pagedReader = (count: number) => {
    const all = Array.from({ length: count }, (_, i) => ({
      _id: `m-${String(i).padStart(6, '0')}`,
      id: `m-${String(i).padStart(6, '0')}`,
      summary: `fact ${i}`,
      tier: 'hot',
      sessionId: 's1',
      lastAccessedAt: new Date('2026-07-10T00:00:00Z'),
    }));
    const findByUserId = vi.fn(async (userId: string, opts: { limit?: number; afterId?: string }) => {
      if (userId !== 'u1') return [];
      return all
        .filter(m => (opts.afterId ? m.id > opts.afterId : true))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, opts.limit ?? all.length);
    });
    return { reader: { findByUserId } as unknown as UserMementoReader, findByUserId };
  };

  it('walks every page, so no belief is lost to the page boundary', async () => {
    const { reader, findByUserId } = pagedReader(PAGE_SIZE + 37);
    const store = createUserMementoMemoryStore({ mementos: reader, ownerUserId: 'u1' });

    const p = await store.readProfile({ kind: 'user', id: 'u1' });

    expect(p?.beliefs).toHaveLength(PAGE_SIZE + 37);
    expect(findByUserId.mock.calls.length).toBeGreaterThan(1);
    for (const call of findByUserId.mock.calls) {
      expect(call[1].limit).toBe(PAGE_SIZE);
    }
  });

  it('advances the cursor instead of re-reading the first page', async () => {
    const { reader, findByUserId } = pagedReader(PAGE_SIZE * 2 + 5);
    const store = createUserMementoMemoryStore({ mementos: reader, ownerUserId: 'u1' });

    const p = await store.readProfile({ kind: 'user', id: 'u1' });

    const cursors = findByUserId.mock.calls.map(c => c[1].afterId);
    expect(cursors[0]).toBeUndefined();
    expect(new Set(cursors).size).toBe(cursors.length);
    // No duplicates reached the fold either, which is what a repeated cursor would produce.
    expect(new Set(p?.beliefs.map(b => b.fact)).size).toBe(PAGE_SIZE * 2 + 5);
  });

  it('stops after one page for a user under the page size', async () => {
    const { reader, findByUserId } = pagedReader(3);
    const store = createUserMementoMemoryStore({ mementos: reader, ownerUserId: 'u1' });

    await store.readProfile({ kind: 'user', id: 'u1' });

    expect(findByUserId).toHaveBeenCalledTimes(1);
  });

  it('throws rather than paging forever when the cursor does not advance', async () => {
    const stuck = {
      findByUserId: vi.fn(async () =>
        Array.from({ length: PAGE_SIZE }, (_, i) => ({
          _id: `m-${String(i).padStart(6, '0')}`,
          id: `m-${String(i).padStart(6, '0')}`,
          summary: `fact ${i}`,
          tier: 'hot',
          lastAccessedAt: new Date('2026-07-10T00:00:00Z'),
        }))
      ),
    } as unknown as UserMementoReader;
    const store = createUserMementoMemoryStore({ mementos: stuck, ownerUserId: 'u1' });

    await expect(store.readProfile({ kind: 'user', id: 'u1' })).rejects.toThrow(/cursor failed to advance/);
  });

  it('refuses to return a partial profile when the walk will not end', async () => {
    // Advancing cursor, always-full page: the cursor check cannot catch this, since advance proves
    // progress and not termination. A profile is every belief, so returning a prefix would present a
    // subset of the user's memory as complete - it throws instead.
    const endless = {
      findByUserId: vi.fn(async (_u: string, opts: { limit?: number; afterId?: string }) => {
        const start = opts.afterId ? Number(opts.afterId.split('-')[1]) + 1 : 0;
        return Array.from({ length: opts.limit ?? PAGE_SIZE }, (_, i) => ({
          _id: `m-${String(start + i).padStart(9, '0')}`,
          id: `m-${String(start + i).padStart(9, '0')}`,
          summary: `fact ${start + i}`,
          tier: 'hot',
          lastAccessedAt: new Date('2026-07-10T00:00:00Z'),
        }));
      }),
    } as unknown as UserMementoReader;
    const store = createUserMementoMemoryStore({ mementos: endless, ownerUserId: 'u1' });

    await expect(store.readProfile({ kind: 'user', id: 'u1' })).rejects.toThrow(/refusing to return a partial profile/);
  });

  it('still refuses another user while paging', async () => {
    const { reader, findByUserId } = pagedReader(PAGE_SIZE + 5);
    const store = createUserMementoMemoryStore({ mementos: reader, ownerUserId: 'u1' });

    expect(await store.readProfile({ kind: 'user', id: 'someone-else' })).toBeNull();
    expect(findByUserId).not.toHaveBeenCalled();
  });
});
