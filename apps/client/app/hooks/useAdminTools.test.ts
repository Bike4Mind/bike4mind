import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAdminTools } from './useAdminTools';

const state = vi.hoisted(() => ({
  currentUser: { id: 'actor', isAdmin: false, adminPermissions: ['settings:manage'] },
  post: vi.fn(),
  canAccess: vi.fn(
    (user: { adminPermissions: string[] }, tool: string) =>
      tool === 'modal' && user.adminPermissions.includes('settings:manage')
  ),
  initialize: vi.fn(),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: Object.assign(() => ({ currentUser: state.currentUser }), {
    getState: () => ({ currentUser: state.currentUser }),
  }),
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: state.post } }));
vi.mock('@client/app/services/adminTools', () => ({
  initializeAdminTools: () => {
    state.initialize();
    return { canAccess: state.canAccess };
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.currentUser = { id: 'actor', isAdmin: false, adminPermissions: ['settings:manage'] };
  state.post.mockResolvedValue({ data: { success: true, type: 'help' } });
});

describe('per-tool delegated administrator access', () => {
  it('initializes and executes modal commands for settings delegates without claiming full admin', async () => {
    const { result } = renderHook(() => useAdminTools());
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.canUseAdminTools).toBe(true);
    expect(state.initialize).toHaveBeenCalled();
    expect(result.current.canAccessTool('modal')).toBe(true);
    expect(result.current.canAccessTool('help')).toBe(false);
    expect(result.current.parseCommand('/admin modal list')).toMatchObject({
      isAdminCommand: true,
      tool: 'modal',
      params: { action: 'list' },
    });
    await act(async () => {
      await result.current.executeAdminTool('modal', { action: 'list' });
    });
    expect(state.canAccess).toHaveBeenCalledWith(state.currentUser, 'modal');
    expect(state.post).toHaveBeenCalledWith(
      '/api/admin/tools/execute',
      expect.objectContaining({ tool: 'modal', params: { action: 'list' } })
    );
  });

  it('denies support-only users and rechecks saved execution after revocation', async () => {
    const { result, rerender } = renderHook(() => useAdminTools());
    const savedExecute = result.current.executeAdminTool;
    state.currentUser = { id: 'actor', isAdmin: false, adminPermissions: ['support:read'] };
    rerender();
    expect(result.current.canUseAdminTools).toBe(false);
    expect(result.current.canAccessTool('modal')).toBe(false);
    await act(async () => {
      expect(await savedExecute('modal', { action: 'list' })).toMatchObject({
        success: false,
        error: 'Missing permission: settings:manage',
      });
    });
    expect(state.post).not.toHaveBeenCalled();
  });

  it('preserves unrelated full-admin tools while keeping them unavailable to delegates', async () => {
    const { result, rerender } = renderHook(() => useAdminTools());
    expect(result.current.parseCommand('add 50 credits')).toEqual({ isAdminCommand: false });
    await act(async () => {
      expect(await result.current.executeAdminTool('credit_management', { action: 'add' })).toMatchObject({
        success: false,
      });
    });
    expect(state.post).not.toHaveBeenCalled();
    state.currentUser = { id: 'actor', isAdmin: true, adminPermissions: [] };
    rerender();
    expect(result.current.isAdmin).toBe(true);
    expect(result.current.canAccessTool('credit_management')).toBe(true);
    await act(async () => {
      await result.current.executeAdminTool('credit_management', { action: 'add' });
    });
    expect(state.post).toHaveBeenCalledWith(
      '/api/admin/tools/execute',
      expect.objectContaining({ tool: 'credit_management' })
    );
  });
});
