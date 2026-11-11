import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AdminPermissionsDialog } from './AdminPermissionsDialog';
import { ProfileTestWrapper, buildProfile } from '../profileTestUtils';
import type { AdminUserProfile } from '../userProfileModel';

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  currentUser: { id: 'admin-1', isAdmin: true } as { id: string; isAdmin: boolean } | null,
}));

vi.mock('./useAdminUserPermissionsUpdate', () => ({ useAdminUserPermissionsUpdate: () => mocks.update }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: mocks.currentUser }) }));

const DIALOG = 'admin-permissions-dialog';

const renderDialog = (user: AdminUserProfile) => {
  const onClose = vi.fn();
  render(<AdminPermissionsDialog user={user} onClose={onClose} />, { wrapper: ProfileTestWrapper });
  return { onClose };
};
const permission = (name: RegExp) => screen.getByRole('checkbox', { name });
const confirmButton = () => screen.getByTestId(`${DIALOG}-confirm-btn`);

describe('AdminPermissionsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUser = { id: 'admin-1', isAdmin: true };
    mocks.update.mockImplementation(async (input: { adminPermissions: string[] }) => input.adminPermissions);
  });

  it('blocks until a permission changes', () => {
    renderDialog(buildProfile({ adminPermissions: ['support:read'] }));
    fireEvent.click(screen.getByTestId(`${DIALOG}-reason-input-preset-0`));

    expect(permission(/Support read/)).toBeChecked();
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByTestId(`${DIALOG}-hint`)).toHaveTextContent('Grant or revoke a permission first.');
  });

  it('sends the loaded set, the new set in canonical order and the reason', async () => {
    const { onClose } = renderDialog(buildProfile({ adminPermissions: ['users:moderate'] }));
    fireEvent.click(permission(/Adjust credits/));
    fireEvent.click(permission(/Support read/));
    fireEvent.click(permission(/Moderate users/));
    fireEvent.click(screen.getByTestId(`${DIALOG}-reason-input-preset-0`));
    fireEvent.click(confirmButton());

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.update).toHaveBeenCalledWith({
      before: ['users:moderate'],
      adminPermissions: ['support:read', 'credits:adjust'],
      reason: 'Joined the support rotation',
    });
  });

  it('refuses edits to the account of the signed-in admin', () => {
    renderDialog(buildProfile({ id: 'admin-1' }));

    expect(permission(/Support read/)).toBeDisabled();
    expect(screen.getByTestId(`${DIALOG}-hint`)).toHaveTextContent('You cannot change your own admin permissions.');
  });

  it('points a Super Admin at the role instead', () => {
    renderDialog(buildProfile({ isAdmin: true }));

    expect(permission(/Support read/)).toBeDisabled();
    expect(screen.getByTestId(`${DIALOG}-hint`)).toHaveTextContent(/Change their role/);
  });
});
