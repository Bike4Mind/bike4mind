import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import TeamSwitcher from './TeamSwitcher';

const mocks = vi.hoisted(() => ({ select: vi.fn(), navigate: vi.fn() }));
vi.mock('@client/app/components/Credits/AccountSelector', () => ({
  useAccounts: () => ({
    accounts: [
      { id: 'a', name: 'Alpha', personal: false },
      { id: 'b', name: 'Beta', personal: false },
    ],
    selectedAccount: { id: 'a', name: 'Alpha', personal: false },
    setSelectedAccount: mocks.select,
  }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: { id: 'owner' } }) }));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useGetUserOrganizations: () => ({ isLoading: false, isError: false }),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
const theme = extendTheme({ ...getThemeConfig() });

describe('team shortcuts', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });
  it('switches account and opens either team in one click', () => {
    render(
      <CssVarsProvider theme={theme}>
        <TeamSwitcher />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('team-switcher-context').textContent).toBe('Team: Alpha');
    fireEvent.click(screen.getByTestId('team-switcher-b-btn'));
    expect(mocks.select).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/organizations/$id', params: { id: 'b' } });
    expect(JSON.parse(localStorage.getItem('team-recents:owner') ?? '[]')).toEqual(['b']);
    fireEvent.click(screen.getByTestId('team-switcher-all-btn'));
    expect(mocks.navigate).toHaveBeenLastCalledWith({ to: '/organizations' });
  });
});
