import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUser } from './create';
import { IUser } from '@bike4mind/common';

describe('createUser — hasUsablePassword', () => {
  let mockAdapters: any;

  beforeEach(() => {
    mockAdapters = {
      db: {
        users: {
          findByUsernameOrEmail: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation(async (user: any) => ({ ...user, id: 'new-user-id' })),
        },
      },
    };
  });

  it('defaults to false when the caller does not pass it (passwordless-first)', async () => {
    await createUser(
      { username: 'shell', email: 'shell@example.com', record: { password: 'irrelevant-junk-value' } },
      mockAdapters
    );

    const created = mockAdapters.db.users.create.mock.calls[0][0];
    expect(created.hasUsablePassword).toBe(false);
  });

  it('respects an explicit true even when password is present (real credential)', async () => {
    await createUser(
      { username: 'real', email: 'real@example.com', record: { password: 'a-real-password', hasUsablePassword: true } },
      mockAdapters
    );

    const created = mockAdapters.db.users.create.mock.calls[0][0];
    expect(created.hasUsablePassword).toBe(true);
  });

  it('respects an explicit false even when password happens to be non-empty (auto-generated junk)', async () => {
    await createUser(
      {
        username: 'junk',
        email: 'junk@example.com',
        record: { password: 'auto-generated-uuid', hasUsablePassword: false },
      },
      mockAdapters
    );

    const created = mockAdapters.db.users.create.mock.calls[0][0];
    expect(created.hasUsablePassword).toBe(false);
  });
});

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

// The shape an OAuth signup with no provider-verified email produces; the E2E
// create-user endpoint mints it deliberately so the state is reachable in QA.
describe('createUser emailless account', () => {
  it('writes email as null and checks uniqueness on the username alone', async () => {
    const db = makeDb();

    await createUser(
      { username: 'no-email-e2e', record: { password: 'x', hasUsablePassword: true } },
      { db: db as any }
    );

    expect(db.users.findByUsernameOrEmail).toHaveBeenCalledWith('no-email-e2e', undefined);
    const persisted = db.users.create.mock.calls[0][0] as Omit<IUser, 'id'>;
    expect(persisted.email).toBeNull();
    expect(persisted.emailVerified).toBe(false);
    expect(persisted.emailVerifiedAt).toBeNull();
  });

  it('reports a username clash as Username, not Email, when there is no email to compare', async () => {
    const db = makeDb();
    db.users.findByUsernameOrEmail.mockResolvedValue({ username: 'taken', email: null });

    await expect(createUser({ username: 'taken' }, { db: db as any })).rejects.toThrow('Username already in use');
  });
});
