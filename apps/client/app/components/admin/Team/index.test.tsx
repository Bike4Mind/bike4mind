import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  team: {
    data: undefined as unknown,
    isLoading: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
  mutation: { mutateAsync: vi.fn(), isPending: false },
}));

vi.mock('@client/app/hooks/data/admin', () => ({
  useGetTeamMembers: () => mocks.team,
  useCreateTeamMember: () => mocks.mutation,
  useUpdateTeamMember: () => mocks.mutation,
  useDeleteTeamMember: () => mocks.mutation,
}));

import Team from './index';

const appTheme = extendTheme({ ...getThemeConfig() });
const themed = () => (
  <CssVarsProvider theme={appTheme}>
    <Team />
  </CssVarsProvider>
);
const renderTeam = () => render(themed());

const members = [
  { id: 'm2', name: 'Zed Example', phone: '+1 555 000 0002' },
  { id: 'm1', name: 'Ada Example', phone: '+1 555 000 0001', role: 'Lead' },
];

describe('Team', () => {
  beforeEach(() => {
    Object.assign(mocks.team, { data: members, isLoading: false, error: null });
    mocks.team.refetch.mockClear();
    mocks.mutation.mutateAsync.mockReset();
  });

  const openRowAction = (id: string, action: 'edit' | 'delete') => {
    fireEvent.click(screen.getByTestId(`team-member-actions-${id}`));
    fireEvent.click(screen.getByTestId(`team-member-${action}-btn-${id}`));
  };

  it('opens with the page header: title, count, description, help and the create action', () => {
    renderTeam();
    const header = screen.getByTestId('admin-page-header');

    expect(screen.getByTestId('admin-team-tab').firstElementChild).toBe(header);
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent(/^Team \(2\)$/);
    expect(header).toHaveTextContent('Internal contact list for User Ops.');
    expect(within(header).getByTestId('help-button-admin-team')).toBeInTheDocument();
    expect(within(header).getByTestId('create-team-member-btn')).toHaveTextContent('Create team member');
  });

  it('opens the create dialog from the header action', () => {
    renderTeam();
    expect(screen.queryByTestId('team-member-name-input')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('create-team-member-btn'));
    expect(screen.getByTestId('team-member-name-input')).toBeInTheDocument();
  });

  it('keeps the header and shows the loading state while members load', () => {
    Object.assign(mocks.team, { data: undefined, isLoading: true });
    renderTeam();

    expect(screen.getByTestId('admin-page-header')).toBeInTheDocument();
    expect(screen.getByTestId('team-members-table')).toHaveAttribute('aria-busy', 'true');
  });

  it('shows an error state whose retry refetches the members', () => {
    Object.assign(mocks.team, { data: undefined, error: new Error('boom') });
    renderTeam();

    expect(screen.getByTestId('admin-error-state')).toHaveTextContent('Could not load team members.');
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(mocks.team.refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the members on screen when a background refetch fails', () => {
    mocks.team.error = new Error('boom');
    renderTeam();

    expect(screen.getByTestId('team-member-row-m1')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-error-state')).not.toBeInTheDocument();
  });

  it('shows an empty state whose action opens the create dialog', () => {
    mocks.team.data = [];
    renderTeam();

    const empty = screen.getByTestId('admin-empty-state');
    expect(empty).toHaveTextContent('No team members yet');
    expect(screen.queryByTestId('team-member-name-input')).not.toBeInTheDocument();

    fireEvent.click(within(empty).getByTestId('team-empty-create-btn'));
    expect(screen.getByTestId('team-member-name-input')).toBeInTheDocument();
  });

  it('renders the members as table rows sorted by name', () => {
    renderTeam();

    const table = screen.getByTestId('team-members-table');
    const rows = within(table).getAllByTestId(/^team-member-row-/);
    expect(rows.map(row => row.getAttribute('data-testid'))).toEqual(['team-member-row-m1', 'team-member-row-m2']);
    expect(screen.getByTestId('team-member-role-m1')).toHaveTextContent('Lead');
    expect(screen.getByTestId('team-member-role-m1')).toHaveAttribute('title', 'Lead');
    expect(screen.queryByTestId('admin-empty-state')).not.toBeInTheDocument();
  });

  it('shows a dash for a member without email or role', () => {
    renderTeam();

    const row = screen.getByTestId('team-member-row-m2');
    expect(screen.queryByTestId('team-member-role-m2')).not.toBeInTheDocument();
    expect(within(row).getAllByText('\u2014').length).toBeGreaterThanOrEqual(2);
  });

  it('opens the edit dialog prefilled from the row actions menu', () => {
    renderTeam();
    openRowAction('m1', 'edit');

    expect(screen.getByTestId('team-member-edit-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('team-member-edit-name-input').querySelector('input')).toHaveValue('Ada Example');
  });

  it('opens the edit dialog on row click but not on a phone link click', () => {
    renderTeam();

    fireEvent.click(screen.getByTestId('team-member-phone-m2'));
    expect(screen.queryByTestId('team-member-edit-dialog')).not.toBeInTheDocument();

    fireEvent.click(within(screen.getByTestId('team-member-row-m2')).getByText('Zed Example'));
    expect(screen.getByTestId('team-member-edit-name-input').querySelector('input')).toHaveValue('Zed Example');
  });

  it('confirms removal in an action dialog instead of window.confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    mocks.mutation.mutateAsync.mockResolvedValue(undefined);
    renderTeam();

    openRowAction('m1', 'delete');
    const dialog = screen.getByTestId('team-member-delete-dialog');
    expect(dialog).toHaveTextContent('Remove Ada Example from the team list?');

    fireEvent.click(screen.getByTestId('team-member-delete-dialog-cancel-btn'));
    await waitFor(() => expect(screen.queryByTestId('team-member-delete-dialog')).not.toBeInTheDocument());
    expect(mocks.mutation.mutateAsync).not.toHaveBeenCalled();

    openRowAction('m1', 'delete');
    fireEvent.click(screen.getByTestId('team-member-delete-confirm-btn'));
    await waitFor(() => expect(screen.queryByTestId('team-member-delete-dialog')).not.toBeInTheDocument());
    expect(mocks.mutation.mutateAsync).toHaveBeenCalledWith('m1');
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('keeps the dialog open with the error when removal fails, and clears it on close', async () => {
    mocks.mutation.mutateAsync.mockRejectedValue(new Error('remove failed'));
    renderTeam();

    openRowAction('m2', 'delete');
    fireEvent.click(screen.getByTestId('team-member-delete-confirm-btn'));

    const dialog = screen.getByTestId('team-member-delete-dialog');
    expect(await within(dialog).findByTestId('team-member-delete-error')).toHaveTextContent('remove failed');

    fireEvent.click(screen.getByTestId('team-member-delete-dialog-cancel-btn'));
    await waitFor(() => expect(screen.queryByTestId('team-member-delete-dialog')).not.toBeInTheDocument());
    expect(screen.queryByTestId('team-member-delete-error')).not.toBeInTheDocument();
  });

  it('moves focus to the next row after a removal', async () => {
    mocks.mutation.mutateAsync.mockResolvedValue(undefined);
    const { rerender } = renderTeam();

    openRowAction('m1', 'delete');
    fireEvent.click(screen.getByTestId('team-member-delete-confirm-btn'));
    await waitFor(() => expect(screen.queryByTestId('team-member-delete-dialog')).not.toBeInTheDocument());

    mocks.team.data = [members[0]];
    rerender(themed());
    await waitFor(() => expect(screen.getByTestId('team-member-row-m2')).toHaveFocus());
  });

  it('moves focus to the create action when the last member is removed', async () => {
    mocks.team.data = [members[0]];
    mocks.mutation.mutateAsync.mockResolvedValue(undefined);
    const { rerender } = renderTeam();

    openRowAction('m2', 'delete');
    fireEvent.click(screen.getByTestId('team-member-delete-confirm-btn'));
    await waitFor(() => expect(screen.queryByTestId('team-member-delete-dialog')).not.toBeInTheDocument());

    mocks.team.data = [];
    rerender(themed());
    await waitFor(() => expect(screen.getByTestId('create-team-member-btn')).toHaveFocus());
  });
});
