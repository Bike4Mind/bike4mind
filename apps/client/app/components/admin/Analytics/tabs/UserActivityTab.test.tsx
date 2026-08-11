import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * The endpoint's 502 used to render as "No data found", which is indistinguishable from a
 * genuinely empty result - that is why the outage went unnoticed. A failure must look like
 * a failure, and the row count must come from the server total, not the page length.
 */
vi.mock('@client/app/utils/organizationAPICalls', () => ({ useGetAllOrganizations: () => ({ data: [] }) }));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

import { UserActivityTab } from './UserActivityTab';
import { useAnalyticsStore } from '../store';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const ROWS = [
  { date: '2026-07-28', counterName: 'Login', userEmail: 'poy@example.com', count: 3, totalValue: 3, metadata: {} },
  { date: '2026-07-27', counterName: 'Logout', userEmail: 'ada@example.com', count: 1, totalValue: 1, metadata: {} },
];

const renderTab = (props: Partial<React.ComponentProps<typeof UserActivityTab>> = {}) =>
  render(
    <TestWrapper>
      <UserActivityTab rows={ROWS} total={2} isFetching={false} error={null} onRefresh={vi.fn()} {...props} />
    </TestWrapper>
  );

describe('UserActivityTab', () => {
  beforeEach(() => {
    useAnalyticsStore.setState({ page: 1, limit: 25 });
  });

  it('reports a failed request instead of an empty result', () => {
    renderTab({ rows: [], total: 0, error: new Error('Request failed with status code 502') });

    expect(screen.getByTestId('user-activity-error')).toBeTruthy();
    expect(screen.queryByText('No data found')).toBeNull();
  });

  it('still says "no data" when the request succeeded with no rows', () => {
    renderTab({ rows: [], total: 0 });

    expect(screen.getByText('No data found')).toBeTruthy();
    expect(screen.queryByTestId('user-activity-error')).toBeNull();
  });

  it('renders the rows the server returned', () => {
    renderTab();

    expect(screen.getByText('poy@example.com')).toBeTruthy();
    expect(screen.getByText('Logout')).toBeTruthy();
  });

  it('counts pages from the server total, not the rows on screen', () => {
    renderTab({ total: 4210 });

    expect(screen.getByText(/Page 1 of 169/)).toBeTruthy();
  });

  it('moves the shared page state so the next page is fetched from the server', () => {
    renderTab({ total: 4210 });

    fireEvent.click(screen.getByLabelText('Next page'));

    expect(useAnalyticsStore.getState().page).toBe(2);
  });

  it('disables Refresh and pagination while a refetch is in flight, without hiding the retained rows', () => {
    renderTab({ total: 4210, isFetching: true });

    expect(screen.getByTestId('user-activity-refresh-btn').closest('button')).toBeDisabled();
    expect(screen.getByLabelText('Next page').closest('button')).toBeDisabled();
    expect(screen.getByLabelText('Previous page').closest('button')).toBeDisabled();
    expect(screen.getAllByTestId('user-activity-row').length).toBeGreaterThan(0);
  });
});
