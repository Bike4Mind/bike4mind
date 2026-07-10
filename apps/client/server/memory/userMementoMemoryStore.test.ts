import { describe, it, expect } from 'vitest';
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
