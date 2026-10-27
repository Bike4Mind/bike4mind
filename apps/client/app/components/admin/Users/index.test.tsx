import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { describe, expect, it, vi } from 'vitest';

// The tab is a wiring layer over many heavy children; stub them so the test covers only the
// created-window hand-off from the signup panel to the filter params and its chip.
vi.mock('./useUsersTabParams', async () => {
  const React = await import('react');
  return {
    PAGE_LIMIT_OPTIONS: [10],
    useUsersTab: Object.assign(() => ['full', vi.fn()], { getState: () => ({ params: {} }) }),
    useUsersTabUrlSync: () => undefined,
    useUsersParams: () => {
      const [params, setParams] = React.useState<Record<string, unknown>>({
        recentSignups: 'hour',
        orgSearch: ['all'],
        page: 1,
      });
      return [params, (patch: Record<string, unknown>) => setParams(current => ({ ...current, ...patch }))];
    },
  };
});
vi.mock('@client/app/hooks/data/user', () => ({
  useGetUsers: () => ({ data: { users: [], totalUsers: 0 }, isLoading: false, isFetching: false, refetch: vi.fn() }),
}));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@client/app/utils/organizationAPICalls', () => ({
  useGetAllOrganizations: () => ({ data: [], isLoading: false }),
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn() } }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isError: false, refetch: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('./exportUsersCsv', () => ({ exportUsersCsv: vi.fn() }));
vi.mock('./AnomalyBanner', () => ({ AnomalyBanner: () => null }));
vi.mock('./EmailDomainGroups', () => ({ EmailDomainGroups: () => null }));
vi.mock('./UsersFilterBar', () => ({ default: () => null }));
vi.mock('./BulkAbuseBar', () => ({ default: () => null }));
vi.mock('./BulkAbuseResponseModal', () => ({ default: () => null }));
vi.mock('./ComplianceModal', () => ({ default: () => null }));
vi.mock('./CreateUserModal', () => ({ default: () => null, useCreateUserModal: () => ({ setOpen: vi.fn() }) }));
vi.mock('./MobileFiltersDrawer', () => ({ default: () => null }));
vi.mock('./PaginationControls', () => ({ default: () => null }));
vi.mock('./Views/FullUsersView', () => ({ FullUsersView: () => null }));
vi.mock('./Views/RecentActivityView', () => ({ default: () => null }));
vi.mock('./Views/SlimUsersView', () => ({ default: () => null }));
vi.mock('./Views/UserJourney', () => ({ default: () => null }));
vi.mock('../AdminProfileModal', () => ({ default: () => null }));
vi.mock('../Signups/SignupActivityPanel', () => ({
  SignupActivityPanel: ({
    onSelectWindow,
  }: {
    onSelectWindow: (window: { createdFrom: string; createdTo: string }) => void;
  }) => (
    <button
      data-testid="signup-panel-select-btn"
      onClick={() => onSelectWindow({ createdFrom: '2026-03-10T11:00:00.000Z', createdTo: '2026-03-10T12:00:00.000Z' })}
    />
  ),
}));

import UsersTab from './index';

const appTheme = extendTheme({ ...getThemeConfig() });

describe('UsersTab created-at window', () => {
  it('shows a chip for the selected window, replaces the recent-signups filter, and clears on delete', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <UsersTab />
      </CssVarsProvider>
    );
    const recent = screen.getByTestId('users-recent-signups-filter') as HTMLInputElement;
    expect(recent.checked).toBe(true);
    expect(screen.queryByTestId('users-created-window-chip')).toBeNull();

    fireEvent.click(screen.getByTestId('signup-panel-select-btn'));
    expect(screen.getByTestId('users-created-window-chip').textContent).toContain('Created');
    expect((screen.getByTestId('users-recent-signups-filter') as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByTestId('users-created-window-clear-btn'));
    expect(screen.queryByTestId('users-created-window-chip')).toBeNull();
  });
});
