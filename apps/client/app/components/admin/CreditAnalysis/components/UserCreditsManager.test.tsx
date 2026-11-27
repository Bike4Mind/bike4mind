import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  useUsers: vi.fn(),
  useUser: vi.fn(),
  navigate: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock('../hooks/useUserCreditsManager', () => ({ useUserCreditsManager: mocks.useUsers }));
vi.mock('@client/app/hooks/data/user', () => ({
  useGetUser: mocks.useUser,
  userQueryKey: (id: string) => ['users', id],
}));
vi.mock('../../Users/Profile/useOpenUserProfile', () => ({ useOpenUserProfile: () => mocks.navigate }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../../Users/Profile/actions/AdjustCreditsDialog', () => ({
  AdjustCreditsDialog: ({
    user,
    onClose,
    onAudit,
  }: {
    user: { id: string };
    onClose: () => void;
    onAudit: () => void;
  }) => (
    <div data-testid="shared-adjust-credits-dialog">
      {user.id}
      <button onClick={onClose}>Close adjustment</button>
      <button data-testid="credits-audit-stub" onClick={onAudit}>
        Audit credits
      </button>
    </div>
  ),
}));

import { UserCreditsManager } from './UserCreditsManager';

const theme = extendTheme({ ...getThemeConfig() });
const row = {
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  currentCredits: 500,
  createdAt: '2026-01-01',
};
const data = { users: [row], totalUsers: 51, totalPages: 3 };
const renderManager = () =>
  render(
    <CssVarsProvider theme={theme}>
      <UserCreditsManager />
    </CssVarsProvider>
  );
const manager = (override: Record<string, unknown> = {}) => ({
  searchQuery: '',
  setSearchQuery: vi.fn(),
  sortDirection: 'desc',
  setSortDirection: vi.fn(),
  pageSize: 25,
  setPageSize: vi.fn(),
  currentPage: 1,
  setCurrentPage: vi.fn(),
  totalUsers: 51,
  users: [row],
  allUsers: { data, isLoading: false, isFetching: false, error: null },
  handleRefresh: mocks.refetch,
  ...override,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useUsers.mockReturnValue(manager());
  mocks.useUser.mockReturnValue({ data: row, isLoading: false, error: null, refetch: mocks.refetch });
});

describe('UserCreditsManager', () => {
  it('uses a server-paged list with search, order and profile navigation', () => {
    renderManager();
    expect(screen.getByTestId('admin-page-header')).toHaveTextContent('User credits (51)');
    expect(screen.getByTestId('user-credits-table')).toHaveTextContent('Ada Lovelace');
    expect(screen.getByTestId('user-credits-table')).toHaveTextContent('Inactive');
    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    expect(mocks.useUsers.mock.results.at(-1)?.value.setCurrentPage).toHaveBeenCalledWith(2);
    fireEvent.change(screen.getByTestId('admin-filter-search-input'), { target: { value: 'Ada' } });
    expect(mocks.useUsers.mock.results.at(-1)?.value.setSearchQuery).toHaveBeenCalledWith('Ada');
    fireEvent.click(screen.getByTestId('credits-user-view-user-1'));
    expect(mocks.navigate).toHaveBeenCalledWith('user-1');
    expect(screen.queryByTestId('admin-table-sort-credits-btn')).toBeNull();
  });

  it('retains online, recent activity and admin status', () => {
    const recent = { ...row, id: 'recent', isOnline: false, isAdmin: true, lastActiveAt: new Date().toISOString() };
    const online = { ...row, id: 'online', isOnline: true };
    mocks.useUsers.mockReturnValue(manager({ users: [recent, online] }));
    renderManager();
    expect(screen.getByTestId('admin-table-row-recent')).toHaveTextContent('Active');
    expect(screen.getByTestId('admin-table-row-recent')).toHaveTextContent('Admin');
    expect(screen.getByTestId('admin-table-row-online')).toHaveTextContent('Online');
  });

  it('opens the shared action only after the user is loaded and links its audit trail', () => {
    renderManager();
    fireEvent.click(screen.getByTestId('credits-user-adjust-user-1'));
    expect(mocks.useUser).toHaveBeenLastCalledWith('user-1');
    expect(screen.getByTestId('shared-adjust-credits-dialog')).toHaveTextContent('user-1');
    fireEvent.click(screen.getByTestId('credits-audit-stub'));
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/admin', search: expect.objectContaining({ category: 'credits' }) })
    );
    expect(screen.queryByTestId('shared-adjust-credits-dialog')).toBeNull();
  });

  it('shows skeletons, retry and clear-search empty states', () => {
    mocks.useUsers.mockReturnValue(manager({ allUsers: { data, isLoading: true, isFetching: true, error: null } }));
    const view = renderManager();
    expect(screen.getAllByTestId('admin-table-skeleton-row')).toHaveLength(8);
    mocks.useUsers.mockReturnValue(manager({ allUsers: { error: new Error('offline') } }));
    view.rerender(
      <CssVarsProvider theme={theme}>
        <UserCreditsManager />
      </CssVarsProvider>
    );
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(mocks.refetch).toHaveBeenCalledOnce();
    const empty = manager({
      searchQuery: 'missing',
      users: [],
      totalUsers: 0,
      allUsers: { data: { users: [], totalUsers: 0, totalPages: 0 } },
    });
    mocks.useUsers.mockReturnValue(empty);
    view.rerender(
      <CssVarsProvider theme={theme}>
        <UserCreditsManager />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('admin-empty-state')).toHaveTextContent('No users match this search');
    fireEvent.click(screen.getByTestId('credits-user-empty-action'));
    expect(empty.setSearchQuery).toHaveBeenCalledWith('');
  });

  it('blocks a failed detail load and offers retry instead of a stale balance', async () => {
    mocks.useUser.mockImplementation((id: string | null) =>
      id ? { data: row, error: new Error('offline'), refetch: mocks.refetch } : { data: undefined, error: null }
    );
    renderManager();
    fireEvent.click(screen.getByTestId('credits-user-adjust-user-1'));
    expect(screen.queryByTestId('shared-adjust-credits-dialog')).toBeNull();
    fireEvent.click(screen.getByTestId('credits-user-retry-btn'));
    await waitFor(() => expect(mocks.refetch).toHaveBeenCalledOnce());
  });
});
