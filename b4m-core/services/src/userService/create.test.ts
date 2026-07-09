import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUser } from './create';

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
