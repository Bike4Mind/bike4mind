import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const useDailyReports = vi.hoisted(() => vi.fn());
vi.mock('@client/app/hooks/useAnalyticsData', () => ({ useDailyReports }));

import { DailyReportTab } from './DailyReportTab';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderTab = () =>
  render(
    <TestWrapper>
      <DailyReportTab />
    </TestWrapper>
  );

describe('DailyReportTab', () => {
  beforeEach(() => {
    useDailyReports.mockReturnValue({ data: [], isLoading: false, isFetching: false, error: null, refetch: vi.fn() });
  });

  it('renders the error card when its own query fails', () => {
    useDailyReports.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetching: false,
      error: new Error('boom'),
      refetch: vi.fn(),
    });

    renderTab();

    expect(screen.getByTestId('daily-report-error')).toBeTruthy();
  });

  it('does not render the error card when its query succeeded', () => {
    renderTab();

    expect(screen.queryByTestId('daily-report-error')).toBeNull();
  });

  // useDailyReports has no placeholderData, so isLoading - not isFetching - is this tab's only
  // loading signal; a background refetch must not hide the previously loaded reports.
  it('keeps showing the loaded reports during a background refetch', () => {
    useDailyReports.mockReturnValue({
      data: [{ date: '2026-08-01', report: 'Some activity' }],
      isLoading: false,
      isFetching: true,
      error: null,
      refetch: vi.fn(),
    });

    renderTab();

    expect(screen.getByText('Report for 2026-08-01')).toBeTruthy();
  });

  it('renders a per-date error as an error card, not as report text', () => {
    useAnalyticsData.mockReturnValue({
      data: {
        reports: [
          { date: '2026-08-02', report: '', error: 'Error generating report for 2026-08-02: db down' },
          { date: '2026-08-01', report: 'Some activity' },
        ],
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    render(
      <TestWrapper>
        <DailyReportTab onRefresh={vi.fn()} />
      </TestWrapper>
    );

    expect(screen.getByTestId('daily-report-error-2026-08-02')).toBeTruthy();
    expect(screen.queryByText('Report for 2026-08-02')).toBeNull();
    expect(screen.getByText('Report for 2026-08-01')).toBeTruthy();
  });
});
