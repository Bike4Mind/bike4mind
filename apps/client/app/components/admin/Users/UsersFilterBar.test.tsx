import { getThemeConfig } from '@client/app/utils/themes';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockIsMobile = vi.fn(() => false);

vi.mock('@client/app/hooks/useIsMobile', () => ({
  useIsMobile: () => mockIsMobile(),
  useIsTablet: () => false,
}));

vi.mock('@client/app/utils/organizationAPICalls', () => ({
  useGetAllOrganizations: () => ({ data: [], isLoading: false }),
}));

vi.mock('@client/app/hooks/data/user', () => ({
  useGetUserTags: () => ({ data: [] }),
}));

vi.mock('@client/app/components/help/ContextHelpButton', () => ({
  default: () => <button data-testid="admin-help-btn" />,
}));

import UsersFilterBar from './UsersFilterBar';
import { DEFAULT_USERS_PARAMS, useUsersTab } from './useUsersTabParams';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const baseProps = {
  displayMode: 'slim' as const,
  onDisplayModeChange: vi.fn(),
  loading: false,
  search: '',
  onSearchChange: vi.fn(),
  onRefresh: vi.fn(),
  onDownloadCsv: vi.fn(),
  onCreateUser: vi.fn(),
  downloadDisabled: false,
  onOpenFilters: vi.fn(),
};

beforeEach(() => {
  mockIsMobile.mockReset().mockReturnValue(false);
  useUsersTab.setState({ params: { ...DEFAULT_USERS_PARAMS } });
});

describe('UsersFilterBar', () => {
  it('shows the filter and sort controls inline on desktop, with no mobile filter toggle', () => {
    render(<UsersFilterBar {...baseProps} />, { wrapper: TestWrapper });

    expect(screen.getByTestId('admin-search-users-input')).toBeInTheDocument();
    expect(screen.getByTestId('admin-org-filter-btn')).toBeInTheDocument();
    expect(screen.getByTestId('admin-tags-filter-btn')).toBeInTheDocument();
    expect(screen.getByTestId('admin-sort-by-select')).toBeInTheDocument();
    expect(screen.getByTestId('admin-sort-order-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-users-filter-toggle')).not.toBeInTheDocument();
  });

  it('moves the filter controls behind a toggle on mobile so the bar stays compact', () => {
    mockIsMobile.mockReturnValue(true);
    render(<UsersFilterBar {...baseProps} />, { wrapper: TestWrapper });

    expect(screen.getByTestId('admin-users-filter-toggle')).toBeInTheDocument();
    // Icon-only buttons need a real accessible name; Tooltip only sets aria-describedby.
    expect(screen.getByLabelText('Open filters')).toBeInTheDocument();
    expect(screen.getByLabelText('Create user')).toBeInTheDocument();
    expect(screen.getByLabelText('Refresh users')).toBeInTheDocument();
    expect(screen.getByLabelText('Download users CSV')).toBeInTheDocument();
    // The drawer owns these on mobile; rendering them here too would duplicate the testids.
    expect(screen.queryByTestId('admin-org-filter-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-sort-order-btn')).not.toBeInTheDocument();
  });

  it('keeps the create-user action reachable in both layouts', () => {
    const { unmount } = render(<UsersFilterBar {...baseProps} />, { wrapper: TestWrapper });
    expect(screen.getByTestId('admin-create-user-btn')).toHaveTextContent('Create User');
    unmount();

    mockIsMobile.mockReturnValue(true);
    render(<UsersFilterBar {...baseProps} />, { wrapper: TestWrapper });
    expect(screen.getByTestId('admin-create-user-btn')).toBeInTheDocument();
  });

  it('offers a clear button only while the search box has text', async () => {
    const onSearchChange = vi.fn();
    const { unmount } = render(<UsersFilterBar {...baseProps} onSearchChange={onSearchChange} />, {
      wrapper: TestWrapper,
    });
    expect(screen.queryByTestId('admin-search-clear-btn')).not.toBeInTheDocument();
    unmount();

    render(<UsersFilterBar {...baseProps} search="ada" onSearchChange={onSearchChange} />, { wrapper: TestWrapper });
    await userEvent.click(screen.getByTestId('admin-search-clear-btn'));

    expect(onSearchChange).toHaveBeenCalledWith('');
  });

  it('offers a clear-filters chip only once a filter is active', () => {
    const { unmount } = render(<UsersFilterBar {...baseProps} />, { wrapper: TestWrapper });
    expect(screen.queryByTestId('admin-clear-filters-chip')).not.toBeInTheDocument();
    unmount();

    useUsersTab.setState({ params: { ...DEFAULT_USERS_PARAMS, tags: ['Admin'] } });
    render(<UsersFilterBar {...baseProps} />, { wrapper: TestWrapper });
    expect(screen.getByTestId('admin-clear-filters-chip')).toHaveTextContent('1 filter');
  });
});
