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
  it("ends the deleted user's realtime connections after the delete", async () => {
    const { adapters, users, endConnections } = makeAdapters();

    await adminDeleteUser('admin-1', { id: 'user-1' }, adapters);

    expect(users.delete).toHaveBeenCalledWith('user-1');
    expect(endConnections).toHaveBeenCalledWith({ userId: 'user-1' });
    expect(users.delete.mock.invocationCallOrder[0]).toBeLessThan(endConnections.mock.invocationCallOrder[0]);
  });

  it('escapes the name and email in the Slack notice', async () => {
    const { adapters, users } = makeAdapters();
    users.findById.mockImplementation(async (id: string) =>
      id === 'admin-1' ? { id, isAdmin: true } : { id, name: '<!channel> & co', email: 'a<!here>@example.com' }
    );
    (adapters.db.adminSettings.findBySettingNames as ReturnType<typeof vi.fn>).mockResolvedValue([true, false]);

    await adminDeleteUser('admin-1', { id: 'user-1' }, adapters);

    const text = (adapters.notify.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(text).toContain('&lt;!channel&gt; &amp; co');
    expect(text).toContain('a&lt;!here&gt;@example.com');
    expect(text).not.toContain('<!channel>');
  });

  it('ends nothing when the caller is not an admin', async () => {
    const { adapters, users, endConnections } = makeAdapters();

    await expect(adminDeleteUser('user-1', { id: 'user-1' }, adapters)).rejects.toThrow();

    expect(users.delete).not.toHaveBeenCalled();
    expect(endConnections).not.toHaveBeenCalled();
  });
});
