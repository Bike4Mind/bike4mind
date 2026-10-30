import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

vi.mock('@tanstack/react-router', async () => (await import('../__tests__/fakeAdminRouter')).fakeRouterModule);

const apiGet = vi.hoisted(() => vi.fn());
const openProfile = vi.hoisted(() => vi.fn());
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: apiGet } }));
vi.mock('@client/app/hooks/data/user', () => ({ useGetUserTags: () => ({ data: [] }) }));
vi.mock('@client/app/utils/organizationAPICalls', () => ({ useGetAllOrganizations: () => ({ data: [] }) }));
vi.mock('./ComplianceModal', () => ({ default: () => null }));
vi.mock('./CreateUserModal', () => ({ default: () => null, useCreateUserModal: () => ({ setOpen: vi.fn() }) }));
vi.mock('./List/UsersBulkActionDialog', async importOriginal => ({
  ...(await importOriginal<typeof import('./List/UsersBulkActionDialog')>()),
  UsersBulkActionDialog: ({ type, target }: { type: string; target: unknown }) => (
    <div data-testid="bulk-dialog">{JSON.stringify({ type, target })}</div>
  ),
}));
vi.mock('./Profile/useOpenUserProfile', () => ({ useOpenUserProfile: () => openProfile }));
vi.mock('./Views/RecentActivityView', () => ({ default: () => <div data-testid="recent-activity" /> }));
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

import { fakeAdminRouter } from '../__tests__/fakeAdminRouter';
import { DEFAULT_USERS_PARAMS, useUsersTab } from './useUsersTabParams';
import UsersTab from './index';
import { AdminCommandPalette } from '../shared/AdminCommandPalette';

const theme = extendTheme({ ...getThemeConfig() });

const row = (id: string, name: string) => ({
  id,
  name,
  email: `${name.toLowerCase()}@example.com`,
  level: 'DemoUser',
  createdAt: '2026-01-01T00:00:00.000Z',
  currentCredits: 100,
  signupMethod: 'email',
  apiKeyCount: 0,
  spend30d: null,
});

const respond = (url: string) => {
  if (url === '/api/admin/users/summary') {
    return { total: 2, activeThisWeek: 1, views: { newThisWeek: 0, highRisk: 0, suspended: 1 } };
  }
  if (url === '/api/admin/signup-anomaly') return undefined;
  if (url === '/api/admin/saved-views') return { views: [] };
  return { users: [row('u1', 'Ada'), row('u2', 'Grace')], totalUsers: 2, page: 1, totalPages: 1 };
};

const renderTab = (withPalette = false) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
  return render(
    withPalette ? (
      <div data-admin-surface>
        <AdminCommandPalette />
        <UsersTab />
      </div>
    ) : (
      <UsersTab />
    ),
    { wrapper: Wrapper }
  );
};

beforeEach(() => {
  apiGet.mockReset();
  openProfile.mockReset();
  apiGet.mockImplementation(async (url: string) => ({ data: respond(url) }));
  act(() => {
    useUsersTab.setState({ params: { ...DEFAULT_USERS_PARAMS } });
    fakeAdminRouter.reset({ tab: 'users' });
  });
});

describe('UsersTab', () => {
  it('renders the summary, the rows and one footer pager', async () => {
    renderTab();
    expect(await screen.findByTestId('admin-users-row-u1')).toBeTruthy();
    expect(screen.getByText(/2 accounts/)).toBeTruthy();
    expect(screen.getAllByTestId('admin-table-footer')).toHaveLength(1);
  });

  it('focuses the users search with / through the admin shortcuts', async () => {
    renderTab(true);
    await screen.findByTestId('admin-users-row-u1');
    fireEvent.keyDown(document.body, { key: '/' });
    expect(screen.getByTestId('admin-users-search-input')).toHaveFocus();
  });

  it('opens the profile page when a row is activated', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('admin-users-name-u2'));
    expect(openProfile).toHaveBeenCalledWith('u2');
  });

  it('applies a built-in view through the URL and asks the server for it', async () => {
    renderTab();
    await screen.findByTestId('admin-users-row-u1');
    fireEvent.click(screen.getByTestId('admin-users-views-suspended-btn'));
    await waitFor(() => expect(fakeAdminRouter.search).toMatchObject({ status: 'suspended', page: 1 }));
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(
        '/api/admin/users',
        expect.objectContaining({ params: expect.objectContaining({ status: 'suspended' }) })
      )
    );
  });

  it('hands the selected ids to a bulk action and drops them when the filter changes', async () => {
    renderTab();
    fireEvent.click(within(await screen.findByTestId('admin-table-select-u1')).getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('admin-users-bulk-contain-btn'));
    expect(JSON.parse(screen.getByTestId('bulk-dialog').textContent ?? '')).toEqual({
      type: 'contain',
      target: { kind: 'ids', userIds: ['u1'] },
    });

    fireEvent.click(screen.getByTestId('admin-users-views-suspended-btn'));
    await waitFor(() => expect(screen.queryByTestId('admin-bulk-action-bar')).toBeNull());
  });

  it('sends the current filter, not ids, once every matching user is selected', async () => {
    renderTab();
    fireEvent.click(screen.getByTestId('admin-users-views-suspended-btn'));
    fireEvent.click(within(await screen.findByTestId('admin-table-select-u1')).getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('admin-select-all-matching-btn'));
    fireEvent.click(screen.getByTestId('admin-users-bulk-suspend-btn'));
    const { target } = JSON.parse(screen.getByTestId('bulk-dialog').textContent ?? '');
    expect(target).toMatchObject({ kind: 'filter', filter: { status: 'suspended' } });
  });

  it('drops a row ticked while the previous filter rows are still showing once the new page lands', async () => {
    let releaseFiltered: () => void = () => undefined;
    apiGet.mockImplementation(async (url: string, config?: { params?: { status?: string } }) => {
      if (url === '/api/admin/users' && config?.params?.status === 'suspended') {
        await new Promise<void>(resolve => (releaseFiltered = resolve));
      }
      return { data: respond(url) };
    });
    renderTab();
    await screen.findByTestId('admin-users-row-u1');

    fireEvent.click(screen.getByTestId('admin-users-views-suspended-btn'));
    await waitFor(() => expect(fakeAdminRouter.search).toMatchObject({ status: 'suspended' }));
    fireEvent.click(within(screen.getByTestId('admin-table-select-u1')).getByRole('checkbox'));
    expect(screen.getByTestId('admin-bulk-action-bar')).toBeTruthy();

    await act(async () => releaseFiltered());
    await waitFor(() => expect(screen.queryByTestId('admin-bulk-action-bar')).toBeNull());
  });

  it('filters to a signup chart window, replacing the signed-up filter, and clears it from the chip', async () => {
    act(() => fakeAdminRouter.reset({ tab: 'users', page: 1, signedUp: 'hour' }));
    renderTab();
    await screen.findByTestId('admin-users-row-u1');

    fireEvent.click(screen.getByTestId('signup-panel-select-btn'));
    await waitFor(() =>
      expect(fakeAdminRouter.search).toMatchObject({
        createdFrom: '2026-03-10T11:00:00.000Z',
        createdTo: '2026-03-10T12:00:00.000Z',
      })
    );
    expect(fakeAdminRouter.search.signedUp).toBeUndefined();
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(
        '/api/admin/users',
        expect.objectContaining({ params: expect.objectContaining({ createdFrom: '2026-03-10T11:00:00.000Z' }) })
      )
    );

    fireEvent.click(await screen.findByTestId('admin-filter-clear-createdWindow-btn'));
    await waitFor(() => expect(fakeAdminRouter.search.createdFrom).toBeUndefined());
    expect(screen.queryByTestId('admin-filter-createdWindow')).toBeNull();
  });

  it('shows an analytics drill-down URL as chips, asks the server for it, and removes each chip with its partners', async () => {
    const drillDown = {
      createdFrom: '2026-10-01T00:00:00.000Z',
      createdTo: '2026-11-01T00:00:00.000Z',
      verdict: 'legit',
      funnelStep: 'firstAction',
      activeFrom: '2026-10-01',
      activeTo: '2026-10-07',
    };
    act(() => fakeAdminRouter.reset({ tab: 'users', page: 1, ...drillDown }));
    renderTab();
    await screen.findByTestId('admin-users-row-u1');

    expect(screen.getByTestId('admin-filter-verdict').textContent).toBe('Verdict:\u00a0Legit');
    expect(screen.getByTestId('admin-filter-funnelStep').textContent).toBe('Funnel:\u00a0First AI use, did not return');
    expect(screen.getByTestId('admin-filter-activeWindow').textContent).toBe(
      'Active:\u00a02026-10-01 \u2013 2026-10-07 UTC'
    );
    expect(apiGet).toHaveBeenCalledWith(
      '/api/admin/users',
      expect.objectContaining({ params: expect.objectContaining(drillDown) })
    );

    fireEvent.click(screen.getByTestId('admin-filter-clear-activeWindow-btn'));
    await waitFor(() => expect(fakeAdminRouter.search.activeFrom).toBeUndefined());
    expect(fakeAdminRouter.search.activeTo).toBeUndefined();
    expect(fakeAdminRouter.search.verdict).toBe('legit');

    // Verdict and funnel step classify the created window, so they leave with it.
    fireEvent.click(screen.getByTestId('admin-filter-clear-createdWindow-btn'));
    await waitFor(() => expect(fakeAdminRouter.search.createdFrom).toBeUndefined());
    expect(fakeAdminRouter.search).not.toHaveProperty('verdict');
    expect(fakeAdminRouter.search).not.toHaveProperty('funnelStep');
    expect(screen.queryByTestId('admin-filter-verdict')).toBeNull();
  });

  it('reads a single active day as one UTC day', async () => {
    act(() => fakeAdminRouter.reset({ tab: 'users', page: 1, activeFrom: '2026-10-03', activeTo: '2026-10-03' }));
    renderTab();
    expect((await screen.findByTestId('admin-filter-activeWindow')).textContent).toBe('Active:\u00a02026-10-03 UTC');
  });

  it("shows the server's reason when a drill-down cannot be resolved", async () => {
    apiGet.mockImplementation(async (url: string) => {
      if (url === '/api/admin/users') {
        throw Object.assign(new Error('Request failed'), {
          isAxiosError: true,
          response: {
            status: 422,
            data: { error: 'Too many signups in this window to classify. Narrow the created range.' },
          },
        });
      }
      return { data: respond(url) };
    });
    renderTab();
    expect(await screen.findByText(/Narrow the created range/)).toBeTruthy();
  });
});
