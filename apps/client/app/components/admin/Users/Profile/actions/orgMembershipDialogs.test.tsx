import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AddToOrganizationDialog, ChangeOrgRoleDialog, RemoveFromOrganizationDialog } from './orgMembershipDialogs';
import { ProfileTestWrapper, buildProfile } from '../profileTestUtils';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  searchResults: [] as unknown[],
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { post: mocks.post, patch: mocks.patch, delete: mocks.delete },
}));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useSearchOrganizations: () => ({ data: { data: mocks.searchResults }, isLoading: false }),
}));

const USER_ID = 'test-user-1';
const user = buildProfile();
const org = (overrides: Record<string, unknown> = {}) => ({
  id: 'org-1',
  name: 'Acme',
  userId: 'owner-1',
  seats: 10,
  adminUserIds: [] as string[],
  users: [{ userId: USER_ID, permissions: ['read'] }],
  ...overrides,
});

const pickReason = (dialogId: string) => fireEvent.click(screen.getByTestId(`${dialogId}-reason-input-preset-0`));
const confirmButton = (dialogId: string) => screen.getByTestId(`${dialogId}-confirm-btn`);

const pickOrganization = async (name: string) => {
  const input = screen.getByTestId('org-add-dialog-org-input');
  fireEvent.mouseDown(input);
  fireEvent.click(await screen.findByRole('option', { name }));
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.post.mockResolvedValue({ data: {} });
  mocks.patch.mockResolvedValue({ data: {} });
  mocks.delete.mockResolvedValue({ data: {} });
  mocks.searchResults = [];
});

describe('AddToOrganizationDialog', () => {
  it('adds the user with the reason, shows seat usage, and undoes by removing them', async () => {
    mocks.searchResults = [org({ id: 'org-2', name: 'Beta', users: [{ userId: 'a' }, { userId: 'b' }] })];
    const onClose = vi.fn();
    render(<AddToOrganizationDialog user={user} memberOrgIds={[]} onClose={onClose} />, {
      wrapper: ProfileTestWrapper,
    });

    expect(screen.getByTestId('org-add-dialog-hint')).toHaveTextContent('Pick an organization.');
    await pickOrganization('Beta');
    expect(screen.getByTestId('org-add-dialog-seats')).toHaveTextContent('3 of 10 paid seats used');
    pickReason('org-add-dialog');
    fireEvent.click(confirmButton('org-add-dialog'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/organizations/org-2/members', {
      userId: USER_ID,
      reason: 'Customer request',
    });

    fireEvent.click(await screen.findByTestId('undo-toast-undo-btn'));
    await waitFor(() =>
      expect(mocks.delete).toHaveBeenCalledWith(`/api/admin/organizations/org-2/members/${USER_ID}`, {
        data: { reason: 'Undo: Customer request' },
      })
    );
  });

  it('blocks an add that would exceed the paid seats', async () => {
    mocks.searchResults = [org({ id: 'org-2', name: 'Beta', seats: 2, users: [{ userId: 'a' }] })];
    render(<AddToOrganizationDialog user={user} memberOrgIds={[]} onClose={vi.fn()} />, {
      wrapper: ProfileTestWrapper,
    });

    await pickOrganization('Beta');
    pickReason('org-add-dialog');

    expect(confirmButton('org-add-dialog')).toBeDisabled();
    expect(screen.getByTestId('org-add-dialog-hint')).toHaveTextContent(
      'Beta uses all 2 paid seats. Raise the seat count on its profile before adding anyone.'
    );
  });

  it('leaves out the organizations the user is already in', async () => {
    mocks.searchResults = [org(), org({ id: 'org-2', name: 'Beta' })];
    render(<AddToOrganizationDialog user={user} memberOrgIds={['org-1']} onClose={vi.fn()} />, {
      wrapper: ProfileTestWrapper,
    });

    fireEvent.mouseDown(screen.getByTestId('org-add-dialog-org-input'));
    expect(await screen.findByRole('option', { name: 'Beta' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Acme' })).not.toBeInTheDocument();
  });
});

describe('ChangeOrgRoleDialog', () => {
  it('makes a member a manager with the reason, then undoes it', async () => {
    const onClose = vi.fn();
    render(<ChangeOrgRoleDialog user={user} org={org()} onClose={onClose} />, { wrapper: ProfileTestWrapper });

    pickReason('org-role-dialog');
    expect(screen.getByTestId('org-role-dialog-hint')).toHaveTextContent('Pick a different role.');
    fireEvent.click(screen.getByTestId('org-role-dialog-role-manager'));
    expect(screen.getByTestId('org-role-dialog-preview-after')).toHaveTextContent('Manager');
    fireEvent.click(confirmButton('org-role-dialog'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.patch).toHaveBeenCalledWith(`/api/admin/organizations/org-1/members/${USER_ID}`, {
      role: 'manager',
      reason: 'Customer request',
    });

    fireEvent.click(await screen.findByTestId('undo-toast-undo-btn'));
    await waitFor(() =>
      expect(mocks.patch).toHaveBeenLastCalledWith(`/api/admin/organizations/org-1/members/${USER_ID}`, {
        role: 'member',
        reason: 'Undo: Customer request',
      })
    );
  });

  it("blocks changing the owner's role", () => {
    render(<ChangeOrgRoleDialog user={user} org={org({ userId: USER_ID, users: [] })} onClose={vi.fn()} />, {
      wrapper: ProfileTestWrapper,
    });
    fireEvent.click(screen.getByTestId('org-role-dialog-role-manager'));
    pickReason('org-role-dialog');

    expect(confirmButton('org-role-dialog')).toBeDisabled();
    expect(screen.getByTestId('org-role-dialog-hint')).toHaveTextContent("The owner's role can't be changed.");
  });
});

describe('RemoveFromOrganizationDialog', () => {
  it('removes the member with the reason and offers no undo', async () => {
    const onClose = vi.fn();
    render(<RemoveFromOrganizationDialog user={user} org={org()} isActive onClose={onClose} />, {
      wrapper: ProfileTestWrapper,
    });

    expect(screen.getByText(/active organization/)).toBeInTheDocument();
    pickReason('org-remove-dialog');
    fireEvent.click(confirmButton('org-remove-dialog'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.delete).toHaveBeenCalledWith(`/api/admin/organizations/org-1/members/${USER_ID}`, {
      data: { reason: 'Customer request' },
    });
    expect(screen.queryByTestId('undo-toast')).not.toBeInTheDocument();
  });

  it('blocks removing the owner', () => {
    render(
      <RemoveFromOrganizationDialog
        user={user}
        org={org({ userId: USER_ID, users: [] })}
        isActive={false}
        onClose={vi.fn()}
      />,
      { wrapper: ProfileTestWrapper }
    );
    pickReason('org-remove-dialog');

    expect(confirmButton('org-remove-dialog')).toBeDisabled();
    expect(screen.getByTestId('org-remove-dialog-hint')).toHaveTextContent(
      'Ada Lovelace owns Acme. Transfer ownership before removing them.'
    );
  });

  it('blocks removing someone who already left', () => {
    render(
      <RemoveFromOrganizationDialog
        user={user}
        org={org({ users: [], adminUserIds: [] })}
        isActive={false}
        onClose={vi.fn()}
      />,
      { wrapper: ProfileTestWrapper }
    );
    pickReason('org-remove-dialog');

    expect(confirmButton('org-remove-dialog')).toBeDisabled();
    expect(screen.getByTestId('org-remove-dialog-hint')).toHaveTextContent('Ada Lovelace is no longer in Acme.');
  });
});
