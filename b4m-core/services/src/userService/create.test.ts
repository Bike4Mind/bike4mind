import { describe, it, expect, vi } from 'vitest';
import { createUser } from './create';
import { IUser } from '@bike4mind/common';

// createUser echoes the record it builds back through db.users.create, so we
// capture the persisted record and assert on how `tags` was normalized.
const makeDb = () => {
  const create = vi
    .fn()
    .mockImplementation((record: Omit<IUser, 'id'>) => Promise.resolve({ id: 'new-user', ...record }));
  return {
    users: {
      findByUsernameOrEmail: vi.fn().mockResolvedValue(null),
      create,
    },
  };
};

describe('createUser tags normalization', () => {
  it('stores [] (never null) when no tags are provided', async () => {
    // Regression for admin-created users stuck on "Loading AI models..." forever:
    // a null tags list is indistinguishable from "not loaded" in tag-gated UI.
    const db = makeDb();

    const user = await createUser(
      { username: 'notags', email: 'notags@example.com', name: 'No Tags' },
      { db: db as any }
    );

    expect(user.tags).toEqual([]);
    const persisted = db.users.create.mock.calls[0][0] as Omit<IUser, 'id'>;
    expect(persisted.tags).toEqual([]);
  });

  it('stores [] when tags is explicitly undefined', async () => {
    const db = makeDb();

    const user = await createUser(
      { username: 'undef', email: 'undef@example.com', name: 'Undef', tags: undefined },
      { db: db as any }
    );

    expect(user.tags).toEqual([]);
  });

  it('preserves provided tags', async () => {
    const db = makeDb();

    const user = await createUser(
      { username: 'tagged', email: 'tagged@example.com', name: 'Tagged', tags: ['qa', 'beta'] },
      { db: db as any }
    );

    expect(user.tags).toEqual(['qa', 'beta']);
    const persisted = db.users.create.mock.calls[0][0] as Omit<IUser, 'id'>;
    expect(persisted.tags).toEqual(['qa', 'beta']);
  });
});
