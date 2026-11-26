import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import RecentActivityView from './RecentActivityView';

const mockQuery = vi.fn();
const refetch = vi.fn();

vi.mock('@client/app/hooks/data/user', () => ({
  useGetRecentActivities: () => mockQuery(),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderView = () => render(<RecentActivityView />, { wrapper: TestWrapper });

const activity = (i: number) => ({
  userId: `user-${i}`,
  datetime: new Date(Date.UTC(2026, 0, 1, 12, i)).toISOString(),
  metadata: { clientIp: `10.0.0.${i}`, path: `/api/p${i}` } as Record<string, string> | undefined,
});

const state = (overrides: Record<string, unknown>) =>
  mockQuery.mockReturnValue({ data: undefined, isLoading: false, isError: false, error: null, refetch, ...overrides });

beforeEach(() => {
  mockQuery.mockReset();
  refetch.mockReset();
});

describe('RecentActivityView', () => {
  it('shows skeleton rows while loading', () => {
    state({ isLoading: true });
    renderView();
    expect(screen.getAllByTestId('admin-table-skeleton-row').length).toBeGreaterThan(0);
  });

  it('shows the empty state when there are no activities', () => {
    state({ data: [] });
    renderView();
    expect(screen.getByTestId('admin-empty-state')).toHaveTextContent('No recent activities found');
  });

  it('shows the error with a retry that refetches', () => {
    state({ isError: true, error: new Error('Boom') });
    renderView();
    expect(screen.getByTestId('admin-error-state')).toHaveTextContent('Boom');
    expect(screen.queryByText('No recent activities found')).toBeNull();
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('renders at most the default limit of 10 rows', () => {
    state({ data: Array.from({ length: 12 }, (_, i) => activity(i)) });
    renderView();
    const table = screen.getByTestId('recent-activity-table');
    expect(within(table).getAllByTestId(/^admin-table-row-/)).toHaveLength(10);
    expect(within(table).getByText('user-9')).toBeInTheDocument();
    expect(within(table).queryByText('user-10')).toBeNull();
    // DataTable only ellipsizes a td or its direct Typography child.
    expect(within(table).getByText('user-9').parentElement?.tagName).toBe('TD');
    expect(screen.queryByTestId('recent-activity-mobile-summary-10')).toBeNull();
    expect(screen.queryByTestId('admin-table-footer')).toBeNull();
  });

  it('sizes the Time column for the full locale timestamp', () => {
    const datetime = new Date(2026, 11, 28, 12, 58, 58);
    state({ data: [{ ...activity(1), datetime: datetime.toISOString() }] });
    renderView();
    const table = screen.getByTestId('recent-activity-table');
    const width = within(table).getByRole('columnheader', { name: 'Time' }).style.width;
    expect(width).toMatch(/^[\d.]+rem$/);
    expect(parseFloat(width)).toBeGreaterThanOrEqual(13.5);
    expect(getComputedStyle(table).minWidth).toBe('41.5rem');
    expect(within(table).getByText(datetime.toLocaleString())).toBeInTheDocument();
  });

  it('falls back to Unknown when metadata is missing', () => {
    state({ data: [{ ...activity(0), metadata: undefined }] });
    renderView();
    const row = within(screen.getByTestId('recent-activity-table')).getByTestId('admin-table-row-0');
    expect(within(row).getAllByText('Unknown')).toHaveLength(2);
  });

  it('expands a mobile row on click and on Enter', () => {
    state({ data: [activity(1), activity(2)] });
    renderView();
    const list = screen.getByTestId('recent-activity-mobile-list');

    const first = screen.getByTestId('recent-activity-mobile-summary-0');
    expect(first).toHaveAttribute('aria-expanded', 'false');
    expect(within(list).queryByText('user-1')).toBeNull();
    fireEvent.click(first);
    expect(first).toHaveAttribute('aria-expanded', 'true');
    expect(within(list).getByText('user-1')).toBeInTheDocument();
    expect(within(list).getByText('10.0.0.1')).toBeInTheDocument();

    const second = screen.getByTestId('recent-activity-mobile-summary-1');
    fireEvent.keyDown(second, { key: 'Enter' });
    expect(second).toHaveAttribute('aria-expanded', 'true');
    expect(within(list).getByText('user-2')).toBeInTheDocument();
    fireEvent.keyDown(second, { key: ' ' });
    expect(second).toHaveAttribute('aria-expanded', 'false');
  });
});
