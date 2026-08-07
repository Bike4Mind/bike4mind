import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const useAnalyticsData = vi.hoisted(() => vi.fn());
vi.mock('@client/app/hooks/useAnalyticsData', () => ({ useAnalyticsData }));

import { DailyReportTab } from './DailyReportTab';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('DailyReportTab', () => {
  beforeEach(() => {
    useAnalyticsData.mockReturnValue({ data: { reports: [] }, isLoading: false, error: null, refetch: vi.fn() });
  });

  it('renders the error card when the error prop is set', () => {
    render(
      <TestWrapper>
        <DailyReportTab loading={false} error={new Error('boom')} onRefresh={vi.fn()} />
      </TestWrapper>
    );

    expect(screen.getByTestId('daily-report-error')).toBeTruthy();
  });

  it('does not render the error card without an error prop', () => {
    render(
      <TestWrapper>
        <DailyReportTab loading={false} onRefresh={vi.fn()} />
      </TestWrapper>
    );

    expect(screen.queryByTestId('daily-report-error')).toBeNull();
  });

  // useAnalyticsData scopes placeholderData off for report mode (apps/client/app/hooks/useAnalyticsData.ts),
  // so isLoading - not isFetching - is this tab's only loading signal; a background refetch must not
  // hide the previously loaded reports.
  it('keeps showing the loaded reports during a background refetch', () => {
    useAnalyticsData.mockReturnValue({
      data: { reports: [{ date: '2026-08-01', report: 'Some activity' }] },
      isLoading: false,
      isFetching: true,
      error: null,
      refetch: vi.fn(),
    });

    render(
      <TestWrapper>
        <DailyReportTab loading={false} onRefresh={vi.fn()} />
      </TestWrapper>
    );

    expect(screen.getByText('Report for 2026-08-01')).toBeTruthy();
  });
});
