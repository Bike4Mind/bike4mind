import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import type { AdminSavedViewResponse } from '@client/app/utils/adminSavedViews';

vi.mock('@tanstack/react-router', async () => (await import('../__tests__/fakeAdminRouter')).fakeRouterModule);

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@client/app/hooks/data/user', () => ({ useGetUserTags: () => ({ data: [] }) }));
vi.mock('@client/app/utils/organizationAPICalls', () => ({ useGetAllOrganizations: () => ({ data: [] }) }));
vi.mock('./ComplianceModal', () => ({ default: () => null }));
vi.mock('./CreateUserModal', () => ({ default: () => null, useCreateUserModal: () => ({ setOpen: vi.fn() }) }));
vi.mock('./List/UsersBulkActionDialog', async importOriginal => ({
  ...(await importOriginal<typeof import('./List/UsersBulkActionDialog')>()),
  UsersBulkActionDialog: () => null,
}));
vi.mock('./Profile/useOpenUserProfile', () => ({ useOpenUserProfile: () => vi.fn() }));
vi.mock('./Views/RecentActivityView', () => ({ default: () => null }));
vi.mock('../Signups/SignupActivityPanel', () => ({ SignupActivityPanel: () => null }));

import { fakeAdminRouter } from '../__tests__/fakeAdminRouter';
import { DEFAULT_USERS_PARAMS, useUsersTab } from './useUsersTabParams';
import UsersTab from './index';

const theme = extendTheme({ ...getThemeConfig() });
const ADMIN_ID = 'a'.repeat(24);

let savedViews: AdminSavedViewResponse<'users'>[] = [];

const respond = (url: string) => {
  if (url === '/api/admin/users/summary') {
    return { total: 2, activeThisWeek: 1, views: { newThisWeek: 0, highRisk: 0, suspended: 1 } };
  }
  if (url === '/api/admin/signup-anomaly') return null;
  if (url === '/api/admin/saved-views') return { views: savedViews };
  return { users: [], totalUsers: 0, page: 1, totalPages: 1 };
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

const VIEW_SEARCH = {
  tab: 'users',
  page: 1,
  status: 'suspended',
  sort: 'name',
  order: 'asc',
  limit: 50,
  tags: ['Beta'],
};

beforeEach(() => {
  savedViews = [];
  Object.values(api).forEach(fn => fn.mockReset());
  api.get.mockImplementation(async (url: string) => ({ data: respond(url) }));
  api.post.mockImplementation(async (_url: string, body: { name: string; shared: boolean; view: unknown }) => {
    const created = {
      id: 'b'.repeat(24),
      surface: 'users' as const,
      name: body.name,
      shared: body.shared,
      ownerId: ADMIN_ID,
      isOwner: true,
      view: body.view as AdminSavedViewResponse<'users'>['view'],
    };
    savedViews = [created];
    return { data: created };
  });
  api.patch.mockImplementation(async (url: string, patch: Partial<AdminSavedViewResponse<'users'>>) => {
    savedViews = savedViews.map(view => (url.endsWith(view.id) ? { ...view, ...patch } : view));
    return { data: savedViews[0] };
  });
  api.delete.mockImplementation(async () => {
    savedViews = [];
    return { data: undefined };
  });
  act(() => {
    useUsersTab.setState({ params: { ...DEFAULT_USERS_PARAMS } });
    fakeAdminRouter.reset({ tab: 'users' });
  });
});

describe('UsersTab saved views', () => {
  it('saves the current view, then re-applying it reproduces the same URL params', async () => {
    act(() => fakeAdminRouter.reset(VIEW_SEARCH));
    renderTab();
    const urlBefore = { ...fakeAdminRouter.search };
    expect(urlBefore).toMatchObject({ status: 'suspended', sort: 'name', order: 'asc', limit: 50, tags: ['Beta'] });

    fireEvent.click(await screen.findByTestId('users-save-view-btn'));
    const dialog = await screen.findByTestId('users-save-view-dialog');
    const confirm = within(dialog).getByTestId('users-save-view-dialog-confirm-btn');
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByTestId('users-save-view-dialog-name-input'), {
      target: { value: '  Suspended betas ' },
    });
    fireEvent.click(within(dialog).getByTestId('users-save-view-dialog-share-checkbox'));
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(screen.queryByTestId('users-save-view-dialog')).toBeNull());
    expect(api.post).toHaveBeenCalledWith('/api/admin/saved-views', {
      surface: 'users',
      name: 'Suspended betas',
      shared: true,
      view: {
        version: 1,
        params: {
          status: 'suspended',
          tags: ['Beta'],
          orgSearch: ['all'],
          sortField: 'name',
          sortOrder: 'asc',
          limit: 50,
        },
      },
    });
    const chip = await screen.findByTestId(`users-saved-view-chip-${'b'.repeat(24)}`);
    expect(chip).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByTestId('admin-users-views-all-btn'));
    await waitFor(() => expect(fakeAdminRouter.search).not.toHaveProperty('status'));
    expect(chip).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(chip);
    await waitFor(() => expect(fakeAdminRouter.search).toEqual(urlBefore));
    expect(chip).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows another admin shared view without an owner menu', async () => {
    savedViews = [
      {
        id: 'c'.repeat(24),
        surface: 'users',
        name: 'Team view',
        shared: true,
        ownerId: 'd'.repeat(24),
        isOwner: false,
        view: { version: 1, params: { sortField: 'createdAt', sortOrder: 'desc', limit: 25, risk: 'high' } },
      },
    ];
    renderTab();
    fireEvent.click(await screen.findByTestId(`users-saved-view-chip-${'c'.repeat(24)}`));
    await waitFor(() => expect(fakeAdminRouter.search).toMatchObject({ risk: 'high', page: 1 }));
    expect(screen.queryByTestId(`users-saved-view-menu-${'c'.repeat(24)}`)).toBeNull();
  });

  it('lets the owner rename, unshare and delete (with confirm) a view', async () => {
    const id = 'b'.repeat(24);
    savedViews = [
      {
        id,
        surface: 'users',
        name: 'Mine',
        shared: true,
        ownerId: ADMIN_ID,
        isOwner: true,
        view: { version: 1, params: { sortField: 'createdAt', sortOrder: 'desc', limit: 25, status: 'active' } },
      },
    ];
    renderTab();

    fireEvent.click(await screen.findByTestId(`users-saved-view-menu-${id}`));
    fireEvent.click(await screen.findByTestId(`users-saved-view-rename-${id}`));
    const rename = await screen.findByTestId('users-rename-view-dialog');
    expect(within(rename).getByTestId('users-rename-view-dialog-confirm-btn')).toBeDisabled();
    fireEvent.change(within(rename).getByTestId('users-rename-view-dialog-name-input'), {
      target: { value: 'Renamed' },
    });
    fireEvent.click(within(rename).getByTestId('users-rename-view-dialog-confirm-btn'));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith(`/api/admin/saved-views/${id}`, { name: 'Renamed' }));
    expect(await screen.findByText('Renamed')).toBeTruthy();

    fireEvent.click(screen.getByTestId(`users-saved-view-menu-${id}`));
    fireEvent.click(await screen.findByTestId(`users-saved-view-share-${id}`));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith(`/api/admin/saved-views/${id}`, { shared: false }));

    fireEvent.click(screen.getByTestId(`users-saved-view-menu-${id}`));
    fireEvent.click(await screen.findByTestId(`users-saved-view-delete-${id}`));
    expect(api.delete).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('users-saved-view-delete-confirm-btn'));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith(`/api/admin/saved-views/${id}`));
    await waitFor(() => expect(screen.queryByTestId(`users-saved-view-chip-${id}`)).toBeNull());
  });

  it('saves the search as typed, even before the debounce reaches the list', async () => {
    renderTab();
    fireEvent.change(await screen.findByTestId('admin-users-search-input'), { target: { value: 'ada' } });
    fireEvent.click(screen.getByTestId('users-save-view-btn'));
    fireEvent.change(await screen.findByTestId('users-save-view-dialog-name-input'), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByTestId('users-save-view-dialog-confirm-btn'));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/api/admin/saved-views',
        expect.objectContaining({
          view: expect.objectContaining({ params: expect.objectContaining({ search: 'ada' }) }),
        })
      )
    );
  });

  it('shows the server message when the name is taken', async () => {
    api.post.mockRejectedValue(
      Object.assign(new Error('409'), {
        isAxiosError: true,
        response: { status: 409, data: { error: 'You already have a view with that name' } },
      })
    );
    renderTab();
    fireEvent.click(await screen.findByTestId('users-save-view-btn'));
    fireEvent.change(await screen.findByTestId('users-save-view-dialog-name-input'), { target: { value: 'Dup' } });
    fireEvent.click(screen.getByTestId('users-save-view-dialog-confirm-btn'));
    expect(await screen.findByTestId('users-save-view-dialog-error')).toHaveTextContent('already have a view');
  });
});
