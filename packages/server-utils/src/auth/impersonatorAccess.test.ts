import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ findById: vi.fn(), resolveRoles: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ User: { findById: h.findById } }));
vi.mock('./adminRoles', () => ({ resolveRoleAdminPermissions: h.resolveRoles }));
vi.mock('@bike4mind/services', () => ({
  userService: {
    accountBlockReasons: (user: { isBanned?: boolean }) => (user.isBanned ? ['banned'] : []),
  },
}));

import { isImpersonatorAuthorized } from './impersonatorAccess';

describe('isImpersonatorAuthorized', () => {
  beforeEach(() => {
    h.findById.mockReset();
    h.resolveRoles.mockReset().mockResolvedValue(undefined);
  });

  it.each([
    ['a full admin', { isAdmin: true }],
    ['a direct users:impersonate grant', { adminPermissions: ['users:impersonate'] }],
  ])('allows %s', async (_label, admin) => {
    h.findById.mockResolvedValue({ id: 'admin-1', ...admin });
    await expect(isImpersonatorAuthorized('admin-1')).resolves.toBe(true);
    expect(h.findById).toHaveBeenCalledWith('admin-1');
  });

  it('allows users:impersonate held through a role', async () => {
    const admin = { id: 'admin-1', adminRoleIds: ['role-1'] } as Record<string, unknown>;
    h.findById.mockResolvedValue(admin);
    h.resolveRoles.mockImplementation(async (user: Record<string, unknown>) => {
      user.roleAdminPermissions = ['users:impersonate'];
    });
    await expect(isImpersonatorAuthorized('admin-1')).resolves.toBe(true);
    expect(h.resolveRoles).toHaveBeenCalledWith(admin);
  });

  it.each([
    ['the account is gone', null],
    ['the account is a system user', { isAdmin: true, isSystem: true }],
    ['the account is blocked', { isAdmin: true, isBanned: true }],
    ['admin access was revoked', { isAdmin: false, adminPermissions: [] }],
    ['only another permission remains', { adminPermissions: ['support:read'] }],
  ])('refuses when %s', async (_label, admin) => {
    h.findById.mockResolvedValue(admin && { id: 'admin-1', ...admin });
    await expect(isImpersonatorAuthorized('admin-1')).resolves.toBe(false);
  });
});
