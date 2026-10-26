import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import { AdminPermissionsEditor } from './AdminPermissionsEditor';

const mocks = vi.hoisted(() => ({ put: vi.fn(), isAdmin: true, adminPermissions: [] as string[] }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { put: mocks.put } }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (state: { currentUser: { isAdmin: boolean; adminPermissions: string[] } }) => unknown) =>
    selector({ currentUser: { isAdmin: mocks.isAdmin, adminPermissions: mocks.adminPermissions } }),
}));

const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
const renderEditor = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={extendTheme({ ...getThemeConfig() })}>
        <AdminPermissionsEditor
          user={{ id: 'target', isAdmin: false, adminPermissions: ['support:read'] } as AdminUserListItem}
        />
      </CssVarsProvider>
    </QueryClientProvider>
  );

describe('AdminPermissionsEditor', () => {
  it('requires a reason and sends exact grants to the dedicated endpoint', async () => {
    mocks.isAdmin = false;
    mocks.adminPermissions = ['settings:manage'];
    mocks.put.mockResolvedValue({ data: {} });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    renderEditor();
    expect(screen.getByTestId('admin-permissions-save')).toBeDisabled();
    fireEvent.click(screen.getByLabelText('users:moderate'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Grant moderation for support coverage' } });
    fireEvent.click(screen.getByTestId('admin-permissions-save'));
    await waitFor(() =>
      expect(mocks.put).toHaveBeenCalledWith('/api/admin/users/target/permissions', {
        adminPermissions: ['support:read', 'users:moderate'],
        isAdmin: false,
        reason: 'Grant moderation for support coverage',
      })
    );
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'user-entitlements', 'target'] })
    );
  });

  it('disables permission changes without settings:manage', () => {
    mocks.isAdmin = false;
    mocks.adminPermissions = [];
    renderEditor();
    expect(screen.getByText('Missing permission: settings:manage')).toBeInTheDocument();
    expect(screen.getByLabelText('Full admin')).toBeDisabled();
    expect(screen.getByLabelText('users:delete')).toBeDisabled();
    expect(screen.getByTestId('admin-permissions-save')).toBeDisabled();
  });
});
