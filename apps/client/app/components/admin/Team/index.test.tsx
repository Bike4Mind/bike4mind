import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  team: {
    data: undefined as unknown,
    isLoading: false,
    isFetching: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
}));

vi.mock('@client/app/hooks/data/admin', () => {
  const mutation = { mutateAsync: vi.fn(), isPending: false };
  return {
    useGetTeamMembers: () => mocks.team,
    useCreateTeamMember: () => mutation,
    useUpdateTeamMember: () => mutation,
    useDeleteTeamMember: () => mutation,
  };
});

import Team from './index';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTeam = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <Team />
    </CssVarsProvider>
  );

const members = [
  { id: 'm2', name: 'Zed Example', phone: '+1 555 000 0002' },
  { id: 'm1', name: 'Ada Example', phone: '+1 555 000 0001', role: 'Lead' },
];

describe('Team', () => {
  beforeEach(() => {
    Object.assign(mocks.team, { data: members, isLoading: false, isFetching: false, error: null });
    mocks.team.refetch.mockClear();
  });

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
    expect(screen.getByTestId('team-loading')).toHaveTextContent('Loading team members');
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

    expect(screen.getByTestId('team-member-card-m1')).toBeInTheDocument();
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

  it('renders the members as cards sorted by name', () => {
    renderTeam();

    const cards = screen.getAllByTestId(/^team-member-card-/);
    expect(cards.map(card => card.getAttribute('data-testid'))).toEqual(['team-member-card-m1', 'team-member-card-m2']);
    expect(screen.getByTestId('team-member-role-m1')).toHaveTextContent('Lead');
    expect(screen.queryByTestId('admin-empty-state')).not.toBeInTheDocument();
  });
});
