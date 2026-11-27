import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AdminPermissionsDialog } from './AdminPermissionsDialog';
import { ProfileTestWrapper, buildProfile } from '../profileTestUtils';
import type { AdminUserProfile } from '../userProfileModel';

type Actor = { id: string; isAdmin?: boolean; adminPermissions?: string[] };
type RolesResult = { isSuccess: boolean; isLoading: boolean; isError: boolean; data: unknown[] | undefined };

const SUPPORT_AGENT = {
  id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  name: 'Support agent',
  description: '',
  permissions: ['support:read', 'users:moderate'],
  memberCount: 1,
};
const BILLING = {
  id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
  name: 'Billing',
  description: '',
  permissions: ['support:read', 'credits:adjust'],
  memberCount: 0,
};

const APPROVERS = {
  id: 'cccccccccccccccccccccccc',
  name: 'Approvers',
  description: '',
  permissions: ['credits:approve_self_grant'],
  memberCount: 1,
};

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  currentUser: { id: 'admin-1', isAdmin: true } as Actor | null,
  roles: { isSuccess: true, isLoading: false, isError: false, data: [] } as RolesResult,
}));

vi.mock('./useAdminUserPermissionsUpdate', () => ({ useAdminUserPermissionsUpdate: () => mocks.update }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: mocks.currentUser }) }));
vi.mock('../../useAdminRoleList', () => ({ useAdminRoleList: () => mocks.roles }));

const DIALOG = 'admin-permissions-dialog';

const renderDialog = (user: AdminUserProfile) => {
  const onClose = vi.fn();
  render(<AdminPermissionsDialog user={user} onClose={onClose} />, { wrapper: ProfileTestWrapper });
  return { onClose };
};
const checkboxIn = (testId: string) => within(screen.getByTestId(testId)).getByRole('checkbox');
const permission = (id: string) => checkboxIn(`${DIALOG}-${id.replace(':', '-')}-checkbox`);
const role = (id: string) => checkboxIn(`${DIALOG}-role-${id}-checkbox`);
const confirmButton = () => screen.getByTestId(`${DIALOG}-confirm-btn`);
const pickReason = () => fireEvent.click(screen.getByTestId(`${DIALOG}-reason-input-preset-0`));

describe('AdminPermissionsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUser = { id: 'admin-1', isAdmin: true };
    mocks.roles = { isSuccess: true, isLoading: false, isError: false, data: [SUPPORT_AGENT, BILLING, APPROVERS] };
    mocks.update.mockImplementation(async (input: { adminPermissions: string[]; adminRoleIds?: string[] }) => ({
      adminPermissions: input.adminPermissions,
      adminRoleIds: input.adminRoleIds ?? [],
    }));
  });

  it('blocks until a role or permission changes', () => {
    renderDialog(buildProfile({ adminPermissions: ['support:read'] }));
    pickReason();

    expect(permission('support:read')).toBeChecked();
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByTestId(`${DIALOG}-hint`)).toHaveTextContent('Change a role or permission first.');
  });

  it('sends the loaded sets, the new permissions in canonical order and the reason', async () => {
    const { onClose } = renderDialog(buildProfile({ adminPermissions: ['users:moderate'] }));
    fireEvent.click(permission('credits:adjust'));
    fireEvent.click(permission('support:read'));
    fireEvent.click(permission('users:moderate'));
    pickReason();
    fireEvent.click(confirmButton());

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.update).toHaveBeenCalledWith({
      before: ['users:moderate'],
      adminPermissions: ['support:read', 'credits:adjust'],
      beforeAdminRoleIds: [],
      adminRoleIds: [],
      reason: 'Joined the support rotation',
    });
  });

  it('assigns and removes roles against the loaded role set', async () => {
    const { onClose } = renderDialog(buildProfile({ adminRoleIds: [SUPPORT_AGENT.id] }));
    expect(role(SUPPORT_AGENT.id)).toBeChecked();
    fireEvent.click(role(SUPPORT_AGENT.id));
    fireEvent.click(role(BILLING.id));
    pickReason();
    fireEvent.click(confirmButton());

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.update).toHaveBeenCalledWith({
      before: [],
      adminPermissions: [],
      beforeAdminRoleIds: [SUPPORT_AGENT.id],
      adminRoleIds: [BILLING.id],
      reason: 'Joined the support rotation',
    });
  });

  it('names both sources when a permission comes from a role and a direct grant', () => {
    renderDialog(buildProfile({ adminPermissions: ['users:moderate'], adminRoleIds: [SUPPORT_AGENT.id] }));

    expect(screen.getByTestId(`${DIALOG}-effective-users-moderate`)).toHaveTextContent(
      'Moderate users (from Support agent; granted directly)'
    );
    expect(screen.getByTestId(`${DIALOG}-effective-support-read`)).toHaveTextContent('(from Support agent)');
  });

  it('disables a role carrying a permission the acting delegate lacks, with the reason', () => {
    mocks.currentUser = { id: 'delegate-1', adminPermissions: ['support:read', 'users:moderate'] };
    renderDialog(buildProfile());

    expect(role(SUPPORT_AGENT.id)).not.toBeDisabled();
    expect(role(BILLING.id)).toBeDisabled();
    expect(screen.getByTestId(`${DIALOG}-role-${BILLING.id}-blocked`)).toHaveTextContent(
      'You do not hold Adjust credits'
    );
  });

  it('disables unticking a held role whose explicit-only permission the acting admin does not hold', () => {
    renderDialog(buildProfile({ adminRoleIds: [APPROVERS.id] }));

    expect(role(APPROVERS.id)).toBeChecked();
    expect(role(APPROVERS.id)).toBeDisabled();
    expect(screen.getByTestId(`${DIALOG}-role-${APPROVERS.id}-blocked`)).toHaveTextContent(
      'Only an admin who holds this permission can grant or revoke it.'
    );
    expect(role(SUPPORT_AGENT.id)).not.toBeDisabled();
  });

  it('allows unticking such a role for a holder, or while another source keeps the permission', () => {
    mocks.currentUser = { id: 'admin-1', isAdmin: true, adminPermissions: ['credits:approve_self_grant'] };
    const { unmount } = render(
      <AdminPermissionsDialog user={buildProfile({ adminRoleIds: [APPROVERS.id] })} onClose={vi.fn()} />,
      { wrapper: ProfileTestWrapper }
    );
    expect(role(APPROVERS.id)).not.toBeDisabled();
    unmount();

    mocks.currentUser = { id: 'admin-1', isAdmin: true };
    renderDialog(buildProfile({ adminRoleIds: [APPROVERS.id], adminPermissions: ['credits:approve_self_grant'] }));
    expect(role(APPROVERS.id)).not.toBeDisabled();
  });

  it('disables an explicit-only permission the acting admin does not hold, with a hint', () => {
    renderDialog(buildProfile());

    expect(permission('credits:approve_self_grant')).toBeDisabled();
    expect(screen.getByTestId(`${DIALOG}-credits-approve_self_grant-unheld`)).toHaveTextContent(
      'Only an admin who holds this permission can grant or revoke it.'
    );
    expect(permission('support:read')).not.toBeDisabled();
  });

  it('enables an explicit-only permission for an admin who holds it', () => {
    mocks.currentUser = { id: 'admin-1', isAdmin: true, adminPermissions: ['credits:approve_self_grant'] };
    renderDialog(buildProfile());

    expect(permission('credits:approve_self_grant')).not.toBeDisabled();
    expect(screen.queryByTestId(`${DIALOG}-credits-approve_self_grant-unheld`)).not.toBeInTheDocument();
  });

  it('leaves roles untouched when the role list cannot load', async () => {
    mocks.roles = { isSuccess: false, isLoading: false, isError: true, data: undefined };
    const { onClose } = renderDialog(buildProfile({ adminRoleIds: [SUPPORT_AGENT.id] }));
    expect(screen.getByTestId(`${DIALOG}-roles-unavailable`)).toBeInTheDocument();
    fireEvent.click(permission('credits:adjust'));
    pickReason();
    fireEvent.click(confirmButton());

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.update).toHaveBeenCalledWith({
      before: [],
      adminPermissions: ['credits:adjust'],
      reason: 'Joined the support rotation',
    });
  });

  it('sends the stored permissions a Super Admin still holds along with an explicit-only grant', async () => {
    mocks.currentUser = { id: 'admin-1', isAdmin: true, adminPermissions: ['credits:self_grant'] };
    const { onClose } = renderDialog(buildProfile({ isAdmin: true, adminPermissions: ['support:read'] }));

    fireEvent.click(permission('credits:self_grant'));
    pickReason();
    fireEvent.click(confirmButton());

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.update).toHaveBeenCalledWith({
      before: ['support:read'],
      adminPermissions: ['support:read', 'credits:self_grant'],
      reason: expect.any(String),
    });
  });

  it('refuses edits to the account of the signed-in admin', () => {
    renderDialog(buildProfile({ id: 'admin-1' }));

    expect(permission('support:read')).toBeDisabled();
    expect(role(BILLING.id)).toBeDisabled();
    expect(screen.getByTestId(`${DIALOG}-hint`)).toHaveTextContent('You cannot change your own admin permissions.');
  });

  it('offers a Super Admin only the permissions their role does not imply, and sends no roles', async () => {
    const { onClose } = renderDialog(buildProfile({ isAdmin: true }));

    expect(screen.queryByTestId(`${DIALOG}-support-read-checkbox`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`${DIALOG}-roles`)).not.toBeInTheDocument();
    pickReason();
    expect(screen.getByTestId(`${DIALOG}-hint`)).toHaveTextContent('Change a permission first.');

    fireEvent.click(permission('credits:self_grant'));
    fireEvent.click(confirmButton());

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.update).toHaveBeenCalledWith({
      before: [],
      adminPermissions: ['credits:self_grant'],
      reason: expect.any(String),
    });
  });
});
