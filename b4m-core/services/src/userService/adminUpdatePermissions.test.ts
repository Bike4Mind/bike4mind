import { describe, expect, it, vi } from 'vitest';
import { adminUpdateUser, assertAdminUpdatePermissions } from './adminUpdate';

describe('admin update field permissions', () => {
  it.each([
    { id: 'target' },
    { id: 'target', creditReason: 'No credit change' },
    { id: 'target', roleChangeReason: 'No role change' },
    { id: 'target', currentCredits: undefined },
  ])('rejects an update without actionable admin fields', parameters => {
    expect(() => assertAdminUpdatePermissions({ adminPermissions: ['support:read'] }, parameters)).toThrow(
      'settings:manage; no actionable update fields'
    );
  });

  it('rejects an empty update using the freshly loaded actor before loading or writing the target', async () => {
    const users = {
      findById: vi.fn().mockResolvedValue({ id: 'support', adminPermissions: ['support:read'] }),
      findByIdWithPassword: vi.fn(),
      update: vi.fn(),
    };
    const adapters = { db: { users } } as unknown as Parameters<typeof adminUpdateUser>[2];
    await expect(adminUpdateUser('support', { id: 'target' }, adapters)).rejects.toThrow(
      'settings:manage; no actionable update fields'
    );
    expect(users.findById).toHaveBeenCalledWith('support');
    expect(users.findByIdWithPassword).not.toHaveBeenCalled();
    expect(users.update).not.toHaveBeenCalled();
  });

  it('allows a credits delegate to adjust credits', () => {
    expect(() =>
      assertAdminUpdatePermissions(
        { adminPermissions: ['credits:adjust'] },
        {
          id: 'target',
          creditDelta: 100,
          creditReason: 'Support compensation',
        }
      )
    ).not.toThrow();
  });
  it('allows a moderation delegate to suspend a user', () => {
    expect(() =>
      assertAdminUpdatePermissions(
        { adminPermissions: ['users:moderate'] },
        {
          id: 'target',
          moderationStatus: 'suspended',
        }
      )
    ).not.toThrow();
  });
  it('rejects a mixed credits request that also promotes the target', () => {
    expect(() =>
      assertAdminUpdatePermissions(
        { adminPermissions: ['credits:adjust'] },
        {
          id: 'target',
          creditDelta: 100,
          isAdmin: true,
        }
      )
    ).toThrow('settings:manage');
  });
  it('requires moderation permission even when the actor can manage settings', () => {
    expect(() =>
      assertAdminUpdatePermissions(
        { adminPermissions: ['settings:manage'] },
        {
          id: 'target',
          isBanned: true,
        }
      )
    ).toThrow('users:moderate');
  });
  it('denies a support-only actor any admin mutation', () => {
    expect(() =>
      assertAdminUpdatePermissions(
        { adminPermissions: ['support:read'] },
        {
          id: 'target',
          currentCredits: 500,
        }
      )
    ).toThrow('credits:adjust');
  });
  it('preserves full legacy admin privileges', () => {
    expect(() =>
      assertAdminUpdatePermissions(
        { isAdmin: true },
        {
          id: 'target',
          isAdmin: false,
          creditDelta: -100,
          isBanned: true,
        }
      )
    ).not.toThrow();
  });
});
