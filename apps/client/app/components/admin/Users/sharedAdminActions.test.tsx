import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import AdminProfile from '../AdminProfile';
import MigrateAgain from './MigrateAgain';

const mocks = vi.hoisted(() => ({ setUserId: vi.fn(), migrate: vi.fn(), permissions: ['support:read'] }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (state: { currentUser: { isAdmin: boolean; adminPermissions: string[] } }) => unknown) =>
    selector({ currentUser: { isAdmin: false, adminPermissions: mocks.permissions } }),
}));
vi.mock('@client/app/components/admin/AdminProfileModal', () => ({
  useAdminProfileModal: (selector: (state: { setUserId: typeof mocks.setUserId }) => unknown) =>
    selector({ setUserId: mocks.setUserId }),
}));
vi.mock('@client/app/utils/userAPICalls', () => ({
  useMigrateUsers: () => ({ mutate: mocks.migrate, isPending: false }),
}));

const renderActions = () =>
  render(
    <CssVarsProvider theme={extendTheme({ ...getThemeConfig() })}>
      <AdminProfile userId="target" />
      <MigrateAgain user={{ id: 'target', name: 'Target', email: 'target@example.com' } as AdminUserListItem} />
    </CssVarsProvider>
  );

describe('shared admin actions across user views', () => {
  it('disables profile and migration actions for support in every embedding view', () => {
    mocks.permissions = ['support:read'];
    renderActions();
    expect(screen.getByTestId('admin-user-profile-btn')).toBeDisabled();
    expect(screen.getByTestId('admin-user-migrate-again-btn')).toBeDisabled();
    expect(screen.getAllByText('Missing permission: settings:manage')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('admin-user-profile-btn'));
    fireEvent.click(screen.getByTestId('admin-user-migrate-again-btn'));
    expect(mocks.setUserId).not.toHaveBeenCalled();
    expect(mocks.migrate).not.toHaveBeenCalled();
  });
  it('admits a settings delegate to both actions', () => {
    mocks.permissions = ['support:read', 'settings:manage'];
    renderActions();
    fireEvent.click(screen.getByTestId('admin-user-profile-btn'));
    fireEvent.click(screen.getByTestId('admin-user-migrate-again-btn'));
    expect(mocks.setUserId).toHaveBeenCalledWith('target');
    expect(mocks.migrate).toHaveBeenCalledWith({
      usersData: [{ name: 'Target', email: 'target@example.com' }],
      sendEmail: true,
      orgId: '',
    });
  });
});
