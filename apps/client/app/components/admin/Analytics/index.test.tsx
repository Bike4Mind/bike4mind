import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * A page turn or refresh must not unmount the grid: keepPreviousData means isLoading goes
 * false while isFetching stays true, and both the retained rows and the progress bar have to
 * be on screen at once for that to read as "refreshing" instead of "gone".
 */
const useAnalyticsData = vi.hoisted(() => vi.fn());
vi.mock('@client/app/hooks/useAnalyticsData', () => ({ useAnalyticsData }));
vi.mock('@client/app/utils/organizationAPICalls', () => ({ useGetAllOrganizations: () => ({ data: [] }) }));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

import AnalyticsTab from './index';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const ROWS = [
  { date: '2026-07-28', counterName: 'Login', userEmail: 'poy@example.com', count: 3, totalValue: 3, metadata: {} },
];

describe('AnalyticsTab', () => {
  it('keeps the previous page on screen and shows a progress bar while refetching', () => {
    useAnalyticsData.mockReturnValue({
      data: { logs: ROWS, total: 1 },
      isLoading: false,
      isFetching: true,
      error: null,
      refetch: vi.fn(),
    });

    render(
      <TestWrapper>
        <AnalyticsTab />
      </TestWrapper>
    );

    expect(screen.getAllByTestId('user-activity-row').length).toBeGreaterThan(0);
    expect(screen.getByRole('progressbar')).toBeTruthy();
  });

  it('shows only the progress bar on the initial cold load', () => {
    useAnalyticsData.mockReturnValue({
      data: undefined,
      isLoading: true,
      isFetching: true,
      error: null,
      refetch: vi.fn(),
    });

    render(
      <TestWrapper>
        <AnalyticsTab />
      </TestWrapper>
    );

    expect(screen.queryByTestId('user-activity-row')).toBeNull();
    expect(screen.getByRole('progressbar')).toBeTruthy();
  });

  it('reserves height for the progress bar even when it is not rendered', () => {
    useAnalyticsData.mockReturnValue({
      data: { logs: ROWS, total: 1 },
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    });

    render(
      <TestWrapper>
        <AnalyticsTab />
      </TestWrapper>
    );

    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByTestId('analytics-progress-slot')).toHaveStyle({ height: '4px' });
  });
});
