import { describe, expect, it, vi, beforeEach } from 'vitest';

const { find } = vi.hoisted(() => ({ find: vi.fn() }));

vi.mock('@bike4mind/database/social', () => ({
  ModalModel: { find },
}));

import { modalManagementTool } from './modalManagement';

const list = (user?: Record<string, unknown>) =>
  modalManagementTool.execute({ action: 'list' }, user === undefined ? undefined : { user });

describe('modalManagementTool permission gate', () => {
  beforeEach(() => {
    find.mockReset();
    find.mockReturnValue({ lean: () => Promise.resolve([]) });
  });

  it.each([
    ['a full admin', { id: 'u1', isAdmin: true }],
    ['a settings:manage delegate', { id: 'u2', isAdmin: false, adminPermissions: ['settings:manage'] }],
  ])('lets %s run the tool', async (_label, user) => {
    const result = await list(user);
    expect(result.success).toBe(true);
    expect(find).toHaveBeenCalledOnce();
  });

  it.each([
    ['no user context', undefined],
    ['a user without admin permissions', { id: 'u3', isAdmin: false }],
    ['a user with a different permission', { id: 'u4', isAdmin: false, adminPermissions: ['support:read'] }],
  ])('denies %s', async (_label, user) => {
    const result = await list(user);
    expect(result).toEqual({ success: false, error: 'Modal management permission required' });
    expect(find).not.toHaveBeenCalled();
  });
});
