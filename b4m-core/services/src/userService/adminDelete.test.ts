import { describe, expect, it, vi } from 'vitest';
import { adminDeleteUser } from './adminDelete';

function makeAdapters() {
  const users = {
    findById: vi.fn(async (id: string) =>
      id === 'admin-1' ? { id, isAdmin: true } : id === 'user-1' ? { id, name: 'User', email: 'u@example.com' } : null
    ),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const endConnections = vi.fn().mockResolvedValue({ connectionIds: ['conn-1'] });
  const adapters = {
    db: {
      users,
      adminSettings: { findBySettingNames: vi.fn().mockResolvedValue([false, false]), findAllByTag: vi.fn() },
      realtimeConnections: { endConnections },
    },
    notify: { send: vi.fn() },
    mailer: { sendDeleteUserEmail: vi.fn() },
  } as unknown as Parameters<typeof adminDeleteUser>[2];
  return { adapters, users, endConnections };
}

describe('adminDeleteUser', () => {
  it('authorizes a delegated deletion grant from the freshly loaded actor', async () => {
    const { adapters, users } = makeAdapters();
    users.findById.mockImplementation(async (id: string) =>
      id === 'admin-1'
        ? { id, isAdmin: false, adminPermissions: ['users:delete'] }
        : { id, name: 'User', email: 'u@example.com' }
    );
    await adminDeleteUser('admin-1', { id: 'user-1' }, adapters);
    expect(users.delete).toHaveBeenCalledWith('user-1');
  });

  it.each([
    ['a full admin', { isAdmin: true }],
    ['a delegated admin', { adminPermissions: ['support:read'] }],
  ])('refuses a delegated deleter against %s', async (_label, privileges) => {
    const { adapters, users, endConnections } = makeAdapters();
    users.findById.mockImplementation(async (id: string) =>
      id === 'admin-1'
        ? { id, isAdmin: false, adminPermissions: ['users:delete', 'support:read'] }
        : { id, name: 'Admin', email: 'a@example.com', ...privileges }
    );
    await expect(adminDeleteUser('admin-1', { id: 'user-1' }, adapters)).rejects.toThrow(
      'Only full administrators can delete users with admin access'
    );
    expect(users.delete).not.toHaveBeenCalled();
    expect(endConnections).not.toHaveBeenCalled();
  });

  it('lets a full admin delete another admin', async () => {
    const { adapters, users } = makeAdapters();
    users.findById.mockImplementation(async (id: string) => ({ id, isAdmin: true }));
    await adminDeleteUser('admin-1', { id: 'user-1' }, adapters);
    expect(users.delete).toHaveBeenCalledWith('user-1');
  });

  it("ends the deleted user's realtime connections after the delete", async () => {
    const { adapters, users, endConnections } = makeAdapters();

    await adminDeleteUser('admin-1', { id: 'user-1' }, adapters);

    expect(users.delete).toHaveBeenCalledWith('user-1');
    expect(endConnections).toHaveBeenCalledWith({ userId: 'user-1' });
    expect(users.delete.mock.invocationCallOrder[0]).toBeLessThan(endConnections.mock.invocationCallOrder[0]);
  });

  it('ends nothing when the caller is not an admin', async () => {
    const { adapters, users, endConnections } = makeAdapters();

    await expect(adminDeleteUser('user-1', { id: 'user-1' }, adapters)).rejects.toThrow();

    expect(users.delete).not.toHaveBeenCalled();
    expect(endConnections).not.toHaveBeenCalled();
  });
});
