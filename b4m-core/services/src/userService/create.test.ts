import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUser } from './create';
import { IUser, RESERVED_USERNAME_MESSAGE } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';

describe('createUser \u2014 hasUsablePassword', () => {
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

describe('createUser - reserved username prefix', () => {
  const makeAdapters = () => ({
    db: {
      users: {
        findByUsernameOrEmail: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(async (user: Omit<IUser, 'id'>) => ({ ...user, id: 'new-user-id' })),
      },
    },
  });

  it.each(['persona-seed', 'Persona-Seed', '\u0440ersona-seed'])(
    'refuses %j unless the caller opts in',
    async username => {
      const adapters = makeAdapters();

      const error = await createUser({ username, email: 'seed@example.com' }, adapters).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestError);
      expect((error as Error).message).toBe(RESERVED_USERNAME_MESSAGE);
      expect(adapters.db.users.create).not.toHaveBeenCalled();
    }
  );

  it('creates it for an admin or test-only caller that passes allowReservedUsername', async () => {
    const adapters = makeAdapters();

    const user = await createUser(
      { username: 'persona-seed', email: 'seed@example.com', allowReservedUsername: true },
      adapters
    );

    expect(user.username).toBe('persona-seed');
  });
});

describe('createUser storage allocation', () => {
  it.each([
    [{}, 1000, null],
    [{ storageLimit: 2500 }, 2500, 2500],
    [{ storageLimit: 0 }, 0, 0],
    [{ storageLimitOverride: 2000, planStorageLimit: 5000 }, 2000, 2000],
    [{ storageLimitOverride: null, planStorageLimit: 5000 }, 5000, null],
  ])('persists the effective limit and explicit override for %j', async (record, limit, override) => {
    const db = makeDb();
    const created = await createUser({ username: 'quotauser', record }, { db });
    expect(created.storageLimit).toBe(limit);
    expect(created.storageLimitOverride).toBe(override);
  });
});
