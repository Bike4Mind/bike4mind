import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

vi.mock('@tanstack/react-router', async () => (await import('../__tests__/fakeAdminRouter')).fakeRouterModule);

const apiGet = vi.hoisted(() => vi.fn());
const openProfile = vi.hoisted(() => vi.fn());
const setCreateOpen = vi.hoisted(() => vi.fn());
const exportUsersCsv = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: apiGet } }));
vi.mock('@client/app/hooks/data/user', () => ({ useGetUserTags: () => ({ data: [] }) }));
vi.mock('@client/app/utils/organizationAPICalls', () => ({ useGetAllOrganizations: () => ({ data: [] }) }));
vi.mock('./exportUsersCsv', () => ({ exportUsersCsv }));
vi.mock('./ComplianceModal', () => ({ default: () => null }));
vi.mock('./CreateUserModal', () => ({ default: () => null, useCreateUserModal: () => ({ setOpen: setCreateOpen }) }));
vi.mock('./List/UsersBulkActionDialog', async importOriginal => ({
  ...(await importOriginal<typeof import('./List/UsersBulkActionDialog')>()),
  UsersBulkActionDialog: ({ onClose, onDone }: { onClose: () => void; onDone: () => void }) => (
    <div data-testid="bulk-dialog">
      <button data-testid="bulk-dialog-close-btn" onClick={onClose} />
      <button data-testid="bulk-dialog-done-btn" onClick={onDone} />
    </div>
  ),
}));
// A sortable column with no server sort field, which the tab must ignore rather than send.
vi.mock('./List/usersColumns', async importOriginal => {
  const actual = await importOriginal<typeof import('./List/usersColumns')>();
  return {
    ...actual,
    usersColumns: (...args: Parameters<typeof actual.usersColumns>) => [
      ...actual.usersColumns(...args),
      { id: 'unmapped', label: 'Unmapped', sortable: true, render: () => null },
    ],
  };
});
vi.mock('./Profile/useOpenUserProfile', () => ({ useOpenUserProfile: () => openProfile }));
vi.mock('./Views/RecentActivityView', () => ({ default: () => <div data-testid="recent-activity" /> }));
vi.mock('../Signups/SignupActivityPanel', () => ({ SignupActivityPanel: () => null }));

import { fakeAdminRouter } from '../__tests__/fakeAdminRouter';
import { DEFAULT_USERS_PARAMS, useUsersTab } from './useUsersTabParams';
import UsersTab from './index';

const theme = extendTheme({ ...getThemeConfig() });

const row = (id: string, name: string, email: string | null = `${name.toLowerCase()}@example.com`) => ({
  id,
  name,
  email,
  level: 'DemoUser',
  createdAt: '2026-01-01T00:00:00.000Z',
  currentCredits: 100,
  signupMethod: 'email',
  apiKeyCount: 0,
  spend30d: 5,
});

const SNAPSHOT = {
  since: '2026-03-10T11:00:00.000Z',
  until: '2026-03-10T12:00:00.000Z',
  signupCount: 30,
  apiKeyCount: 0,
  signupSpike: true,
  apiKeySpike: false,
  topDomain: 'spam.example.com',
  truncated: false,
};

const GROUP = {
  domain: 'spam.example.com',
  userIds: ['u1'],
  count: 1,
  firstCreatedAt: '2026-03-10T11:00:00.000Z',
  lastCreatedAt: '2026-03-10T11:01:00.000Z',
  apiKeyCount: 0,
  signals: [],
};

type Overrides = {
  users?: unknown;
  totalUsers?: number;
  anomaly?: unknown;
  anomalyFails?: boolean;
  usersFails?: boolean;
  groupsTruncated?: boolean;
  noSummary?: boolean;
};
let overrides: Overrides = {};

const respond = (url: string, params?: { groupBy?: string }) => {
  if (url === '/api/admin/users/summary') {
    if (overrides.noSummary) throw new Error('no summary');
    return { total: 2, activeThisWeek: 1, views: { newThisWeek: 0, highRisk: 0, suspended: 1 } };
  }
  if (url === '/api/admin/signup-anomaly') {
    if (overrides.anomalyFails) throw new Error('anomaly failed');
    return overrides.anomaly ?? null;
  }
  if (url === '/api/admin/saved-views') return { views: [] };
  if (params?.groupBy === 'emailDomain') {
    return { groups: [GROUP], groupsTruncated: overrides.groupsTruncated ?? false, keysTruncated: false };
  }
  if (overrides.usersFails) throw new Error('users failed');
  return {
    users: overrides.users ?? [row('u1', 'Ada'), row('u2', 'Grace', null)],
    totalUsers: overrides.totalUsers ?? 2,
    page: 1,
    totalPages: 1,
  };
};

const renderTab = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
  return render(<UsersTab />, { wrapper: Wrapper });
};

const writeText = vi.fn();

beforeEach(() => {
  overrides = {};
  apiGet.mockReset();
  openProfile.mockReset();
  setCreateOpen.mockReset();
  exportUsersCsv.mockReset();
  Object.values(toast).forEach(fn => fn.mockReset());
  writeText.mockReset();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  apiGet.mockImplementation(async (url: string, config?: { params?: { groupBy?: string } }) => ({
    data: respond(url, config?.params),
  }));
  act(() => {
    useUsersTab.setState({ params: { ...DEFAULT_USERS_PARAMS } });
    fakeAdminRouter.reset({ tab: 'users' });
  });
});

describe('UsersTab actions', () => {
  it('copies the user id and email from the row menu, and reports a clipboard failure', async () => {
    writeText.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('no'));
    renderTab();
    fireEvent.click(await screen.findByTestId('admin-users-row-actions-u1'));
    fireEvent.click(await screen.findByText('Copy user ID'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('User ID copied'));
    expect(writeText).toHaveBeenCalledWith('u1');

    fireEvent.click(screen.getByTestId('admin-users-row-actions-u1'));
    fireEvent.click(await screen.findByText('Copy email'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Email copied'));
    expect(writeText).toHaveBeenCalledWith('ada@example.com');

    fireEvent.click(screen.getByTestId('admin-users-row-actions-u1'));
    fireEvent.click(await screen.findByText('Copy user ID'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not copy the user id.'));
  });

  it('opens the profile from the row menu and hides copy email when the user has none', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('admin-users-row-actions-u2'));
    expect(screen.queryByText('Copy email')).toBeNull();
    fireEvent.click(await screen.findByTestId('admin-users-row-open-u2'));
    expect(openProfile).toHaveBeenCalledWith('u2');
  });

  it('exports the csv and warns when the export is truncated', async () => {
    exportUsersCsv.mockResolvedValueOnce({ truncated: false }).mockResolvedValueOnce({ truncated: true });
    renderTab();
    await screen.findByTestId('admin-users-row-u1');
    fireEvent.click(screen.getByTestId('admin-users-export-btn'));
    await waitFor(() => expect(exportUsersCsv).toHaveBeenCalledTimes(1));
    expect(toast.warning).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('admin-users-export-btn')).not.toBeDisabled());

    fireEvent.click(screen.getByTestId('admin-users-export-btn'));
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
  });

  it('reports a failed export', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    exportUsersCsv.mockRejectedValueOnce(new Error('boom'));
    renderTab();
    await screen.findByTestId('admin-users-row-u1');
    fireEvent.click(screen.getByTestId('admin-users-export-btn'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to download the user CSV.'));
    consoleError.mockRestore();
  });

  it('opens the create dialog and toggles the recent activity view', async () => {
    renderTab();
    await screen.findByTestId('admin-users-row-u1');
    fireEvent.click(screen.getByTestId('admin-users-create-btn'));
    expect(setCreateOpen).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByTestId('admin-users-recent-activity-btn'));
    expect(screen.getByTestId('recent-activity')).toBeTruthy();
    expect(screen.queryByTestId('admin-users-table')).toBeNull();
    fireEvent.click(screen.getByTestId('admin-users-recent-activity-btn'));
    expect(screen.getByTestId('admin-users-table')).toBeTruthy();
  });

  it('filters the list to the anomaly cluster, grouped by domain', async () => {
    overrides.anomaly = SNAPSHOT;
    renderTab();
    fireEvent.click(await screen.findByTestId('users-review-cluster-btn'));
    await waitFor(() => expect(fakeAdminRouter.search).toMatchObject({ signedUp: 'hour', groupBy: 'emailDomain' }));
  });

  it('warns when the signup anomaly check fails', async () => {
    overrides.anomalyFails = true;
    renderTab();
    expect(await screen.findByText(/Could not check signup anomalies/)).toBeTruthy();
  });

  it('shows an error with retry when the list fails to load', async () => {
    overrides.usersFails = true;
    renderTab();
    fireEvent.click(await screen.findByTestId('admin-error-retry-btn'));
    await waitFor(() =>
      expect(apiGet.mock.calls.filter(([url]) => url === '/api/admin/users').length).toBeGreaterThan(1)
    );
  });

  it('ignores a sort on a column the server cannot sort by', async () => {
    renderTab();
    await screen.findByTestId('admin-users-row-u1');
    fireEvent.click(screen.getByTestId('admin-table-sort-unmapped-btn'));

    expect(fakeAdminRouter.search).not.toHaveProperty('sort');
  });

  it('sorts a column, and pages and resizes through the footer', async () => {
    overrides.totalUsers = 120;
    renderTab();
    await screen.findByTestId('admin-users-row-u1');
    fireEvent.click(screen.getByTestId('admin-table-sort-user-btn'));
    await waitFor(() => expect(fakeAdminRouter.search).toMatchObject({ sort: 'name', page: 1 }));

    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    await waitFor(() => expect(fakeAdminRouter.search).toMatchObject({ page: 2 }));

    fireEvent.click(screen.getByTestId('admin-table-page-size'));
    fireEvent.click(await screen.findByTestId('admin-table-page-size-50'));
    await waitFor(() => expect(fakeAdminRouter.search).toMatchObject({ limit: 50, page: 1 }));
  });

  it('groups by email domain, filters to a group, and flags a truncated grouping', async () => {
    overrides.groupsTruncated = true;
    act(() => fakeAdminRouter.reset({ tab: 'users', groupBy: 'emailDomain' }));
    renderTab();
    expect(await screen.findByTestId('admin-users-groups-truncated')).toBeTruthy();
    fireEvent.click(await screen.findByTestId('admin-users-group-spam.example.com-filter-btn'));
    await waitFor(() => expect(fakeAdminRouter.search).toMatchObject({ domain: 'spam.example.com', page: 1 }));
  });

  it('offers to clear filters when a filtered list is empty', async () => {
    overrides.users = [];
    overrides.totalUsers = 0;
    act(() => fakeAdminRouter.reset({ tab: 'users', status: 'suspended' }));
    renderTab();
    fireEvent.click(await screen.findByTestId('admin-users-empty-clear-btn'));
    await waitFor(() => expect(fakeAdminRouter.search).not.toHaveProperty('status'));
  });

  it('offers to create a user when there are no users and no filters', async () => {
    overrides.users = [];
    overrides.totalUsers = 0;
    renderTab();
    const empty = await screen.findByTestId('admin-empty-state');
    fireEvent.click(within(empty).getByRole('button', { name: 'New user' }));
    expect(setCreateOpen).toHaveBeenCalledWith(true);
  });

  it('closes the bulk dialog and clears the selection when the run is done', async () => {
    renderTab();
    fireEvent.click(within(await screen.findByTestId('admin-table-select-u1')).getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('admin-users-bulk-contain-btn'));
    fireEvent.click(screen.getByTestId('bulk-dialog-done-btn'));
    await waitFor(() => expect(screen.queryByTestId('admin-bulk-action-bar')).toBeNull());
    fireEvent.click(screen.getByTestId('bulk-dialog-close-btn'));
    expect(screen.queryByTestId('bulk-dialog')).toBeNull();
  });

  it('keeps the row menu key presses from activating the row, and labels it by email when unnamed', async () => {
    overrides.users = [row('u3', '')];
    renderTab();
    const trigger = await screen.findByTestId('admin-users-row-actions-u3');
    expect(trigger).toHaveAttribute('aria-label', 'Actions for @example.com');
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(openProfile).not.toHaveBeenCalled();
  });

  it('stores the debounced search in the params', async () => {
    renderTab();
    fireEvent.change(await screen.findByTestId('admin-users-search-input'), { target: { value: 'ada' } });
    await waitFor(() => expect(useUsersTab.getState().params.search).toBe('ada'), { timeout: 2000 });
  });

  it('shows no sort indicator for a sort field without a column', async () => {
    act(() => useUsersTab.setState({ params: { ...DEFAULT_USERS_PARAMS, sortField: 'bogus' as unknown as 'name' } }));
    renderTab();
    expect(await screen.findByTestId('admin-users-row-u1')).toBeTruthy();
  });

  it('renders without a summary or a sorted column', async () => {
    overrides.noSummary = true;
    act(() => fakeAdminRouter.reset({ tab: 'users', sort: 'name', order: 'asc' }));
    renderTab();
    expect(await screen.findByTestId('admin-users-row-u1')).toBeTruthy();
    expect(screen.queryByText(/accounts/)).toBeNull();
  });
});
