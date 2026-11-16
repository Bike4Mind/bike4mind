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
    mocks.roles = { isSuccess: true, isLoading: false, isError: false, data: [SUPPORT_AGENT, BILLING] };
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
      'You do not hold credits:adjust'
    );
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

  it('refuses edits to the account of the signed-in admin', () => {
    renderDialog(buildProfile({ id: 'admin-1' }));

    expect(permission('support:read')).toBeDisabled();
    expect(role(BILLING.id)).toBeDisabled();
    expect(screen.getByTestId(`${DIALOG}-hint`)).toHaveTextContent('You cannot change your own admin permissions.');
  });

  it('points a Super Admin at the role instead', () => {
    renderDialog(buildProfile({ isAdmin: true }));

    expect(permission('support:read')).toBeDisabled();
    expect(screen.getByTestId(`${DIALOG}-hint`)).toHaveTextContent(/Change their role/);
  });
});
