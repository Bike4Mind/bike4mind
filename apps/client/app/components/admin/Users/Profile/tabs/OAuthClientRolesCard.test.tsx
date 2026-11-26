import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import type { UserOAuthClientRolesView } from '@bike4mind/common';
import { OAuthClientRolesCard } from './OAuthClientRolesCard';
import { ProfileTestWrapper, buildProfile } from '../profileTestUtils';

const mocks = vi.hoisted(() => ({
  fetchUserOAuthClientRoles: vi.fn(),
  assignUserOAuthClientRole: vi.fn(),
  unassignUserOAuthClientRole: vi.fn(),
  currentUser: { id: 'admin-1', isAdmin: true } as { id: string; isAdmin?: boolean; adminPermissions?: string[] },
}));

vi.mock('@client/app/utils/oauthClientAPICalls', () => ({
  fetchUserOAuthClientRoles: mocks.fetchUserOAuthClientRoles,
  assignUserOAuthClientRole: mocks.assignUserOAuthClientRole,
  unassignUserOAuthClientRole: mocks.unassignUserOAuthClientRole,
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: mocks.currentUser }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const USER_ID = 'test-user-1';
const appA: UserOAuthClientRolesView = {
  clientId: 'b4m_a',
  clientName: 'App A',
  isActive: true,
  roles: [
    { key: 'admin', label: 'Admin' },
    { key: 'viewer', label: 'Viewer' },
  ],
  assigned: [{ role: 'admin', label: 'Admin', assignedBy: 'a1', assignedAt: '2026-01-01T00:00:00.000Z' }],
};
const appB: UserOAuthClientRolesView = {
  clientId: 'b4m_b',
  clientName: 'App B',
  isActive: false,
  roles: [{ key: 'ops', label: 'Ops' }],
  assigned: [{ role: 'ops', label: 'Ops', assignedBy: 'a1', assignedAt: '2026-01-01T00:00:00.000Z' }],
};

const renderCard = () => render(<OAuthClientRolesCard user={buildProfile()} />, { wrapper: ProfileTestWrapper });

const pickReason = (dialog: 'assign' | 'remove') =>
  fireEvent.click(screen.getByTestId(`user-oauth-role-${dialog}-dialog-reason-input-preset-0`));

const choose = async (selectId: string, optionId: string) => {
  fireEvent.click(within(screen.getByTestId(selectId)).getByRole('combobox'));
  fireEvent.click(await screen.findByTestId(optionId));
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentUser = { id: 'admin-1', isAdmin: true };
  mocks.fetchUserOAuthClientRoles.mockResolvedValue([appA, appB]);
});

describe('OAuthClientRolesCard', () => {
  it('lists the roles the user holds per app, flagging an inactive app', async () => {
    renderCard();
    expect(await screen.findByTestId('user-oauth-role-b4m_a-admin')).toHaveTextContent('App A');
    expect(screen.getByTestId('user-oauth-role-b4m_a-admin')).toHaveTextContent('Admin');
    expect(screen.getByTestId('user-oauth-role-b4m_b-ops')).toHaveTextContent('Ops');
    expect(screen.getByTestId('user-oauth-role-b4m_b-inactive')).toBeInTheDocument();
    expect(screen.queryByTestId('user-oauth-role-b4m_a-inactive')).not.toBeInTheDocument();
    expect(mocks.fetchUserOAuthClientRoles).toHaveBeenCalledWith(USER_ID);
  });

  it('shows read-only rows to an admin without settings:manage', async () => {
    mocks.currentUser = { id: 'd1', isAdmin: false, adminPermissions: ['support:read'] };
    renderCard();
    await screen.findByTestId('user-oauth-role-b4m_a-admin');
    expect(screen.queryByTestId('user-oauth-role-assign-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('user-oauth-role-b4m_a-admin-remove-btn')).not.toBeInTheDocument();
  });

  it('does not fetch or render for a viewer without support:read or settings:manage', async () => {
    mocks.currentUser = { id: 'd1', isAdmin: false, adminPermissions: ['users:moderate'] };
    renderCard();
    await waitFor(() => expect(screen.queryByTestId('user-oauth-roles-card')).not.toBeInTheDocument());
    expect(mocks.fetchUserOAuthClientRoles).not.toHaveBeenCalled();
  });

  it('shows read-only rows to a delegated settings manager viewing an account with admin access', async () => {
    mocks.currentUser = { id: 'd1', isAdmin: false, adminPermissions: ['settings:manage'] };
    render(<OAuthClientRolesCard user={buildProfile({ adminPermissions: ['support:read'] })} />, {
      wrapper: ProfileTestWrapper,
    });
    await screen.findByTestId('user-oauth-role-b4m_a-admin');
    expect(screen.queryByTestId('user-oauth-role-assign-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('user-oauth-role-b4m_a-admin-remove-btn')).not.toBeInTheDocument();
  });

  it('shows an empty state, noting when no app offers roles', async () => {
    mocks.fetchUserOAuthClientRoles.mockResolvedValue([]);
    renderCard();
    expect(await screen.findByTestId('user-oauth-roles-empty')).toHaveTextContent('No OAuth client offers roles yet.');
    expect(screen.queryByTestId('user-oauth-role-assign-btn')).not.toBeInTheDocument();
  });

  it('shows an empty state without the note when apps offer roles', async () => {
    mocks.fetchUserOAuthClientRoles.mockResolvedValue([{ ...appA, assigned: [] }]);
    renderCard();
    expect(await screen.findByTestId('user-oauth-roles-empty')).not.toHaveTextContent('offers roles');
    expect(screen.getByTestId('user-oauth-role-assign-btn')).toBeInTheDocument();
  });

  it('shows a loading state, then an error with a retry', async () => {
    mocks.fetchUserOAuthClientRoles.mockRejectedValueOnce(new Error('boom'));
    renderCard();
    expect(screen.getByTestId('user-oauth-roles-loading')).toBeInTheDocument();
    fireEvent.click(await screen.findByTestId('admin-error-retry-btn'));
    expect(await screen.findByTestId('user-oauth-role-b4m_a-admin')).toBeInTheDocument();
  });

  it('assigns a role the user does not hold yet, then refreshes', async () => {
    mocks.assignUserOAuthClientRole.mockResolvedValue(undefined);
    renderCard();
    fireEvent.click(await screen.findByTestId('user-oauth-role-assign-btn'));
    const confirm = screen.getByTestId('user-oauth-role-assign-dialog-confirm-btn');
    pickReason('assign');
    expect(confirm).toBeDisabled();
    expect(screen.getByTestId('user-oauth-role-assign-dialog')).toHaveTextContent('Pick an app.');
    // App B offers nothing the user lacks, so only App A is offered.
    fireEvent.click(within(screen.getByTestId('user-oauth-role-client-select')).getByRole('combobox'));
    expect(screen.queryByTestId('user-oauth-role-client-option-b4m_b')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByTestId('user-oauth-role-client-option-b4m_a'));
    expect(screen.getByTestId('user-oauth-role-assign-dialog')).toHaveTextContent('Pick a role.');
    fireEvent.click(within(screen.getByTestId('user-oauth-role-role-select')).getByRole('combobox'));
    expect(screen.queryByTestId('user-oauth-role-role-option-admin')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByTestId('user-oauth-role-role-option-viewer'));
    expect(confirm).toHaveTextContent('Assign Viewer');
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(mocks.assignUserOAuthClientRole).toHaveBeenCalledWith(USER_ID, {
        clientId: 'b4m_a',
        role: 'viewer',
        reason: expect.any(String),
      })
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Ada Lovelace now has Viewer on App A.'));
    expect(screen.queryByTestId('user-oauth-role-assign-dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.fetchUserOAuthClientRoles).toHaveBeenCalledTimes(2));
  });

  it('keeps the assign dialog open and reports a failure', async () => {
    mocks.assignUserOAuthClientRole.mockRejectedValue(new Error('not offered'));
    renderCard();
    fireEvent.click(await screen.findByTestId('user-oauth-role-assign-btn'));
    await choose('user-oauth-role-client-select', 'user-oauth-role-client-option-b4m_a');
    await choose('user-oauth-role-role-select', 'user-oauth-role-role-option-viewer');
    pickReason('assign');
    fireEvent.click(screen.getByTestId('user-oauth-role-assign-dialog-confirm-btn'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('not offered'));
    expect(screen.getByTestId('user-oauth-role-assign-dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('user-oauth-role-assign-dialog-cancel-btn'));
    await waitFor(() => expect(screen.queryByTestId('user-oauth-role-assign-dialog')).not.toBeInTheDocument());
  });

  it('removes a role with a reason', async () => {
    mocks.unassignUserOAuthClientRole.mockResolvedValue(undefined);
    renderCard();
    fireEvent.click(await screen.findByTestId('user-oauth-role-b4m_a-admin-remove-btn'));
    pickReason('remove');
    fireEvent.click(screen.getByTestId('user-oauth-role-remove-dialog-confirm-btn'));
    await waitFor(() =>
      expect(mocks.unassignUserOAuthClientRole).toHaveBeenCalledWith(USER_ID, {
        clientId: 'b4m_a',
        role: 'admin',
        reason: expect.any(String),
      })
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Removed Admin on App A from Ada Lovelace.'));
    expect(screen.queryByTestId('user-oauth-role-remove-dialog')).not.toBeInTheDocument();
  });

  it('reports a failed remove and keeps the dialog open', async () => {
    mocks.unassignUserOAuthClientRole.mockRejectedValue(new Error('gone'));
    renderCard();
    fireEvent.click(await screen.findByTestId('user-oauth-role-b4m_b-ops-remove-btn'));
    pickReason('remove');
    fireEvent.click(screen.getByTestId('user-oauth-role-remove-dialog-confirm-btn'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('gone'));
    fireEvent.click(screen.getByTestId('user-oauth-role-remove-dialog-cancel-btn'));
    await waitFor(() => expect(screen.queryByTestId('user-oauth-role-remove-dialog')).not.toBeInTheDocument());
  });
});
