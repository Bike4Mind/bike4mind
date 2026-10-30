import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

/** The tab owns its query, so the error card shows that query's error and nothing else's. */
const useWeeklyReports = vi.hoisted(() => vi.fn());
vi.mock('@client/app/hooks/useWeeklyReports', () => ({ useWeeklyReports }));

import { WeeklyReportTab } from './WeeklyReportTab';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderTab = () =>
  render(
    <TestWrapper>
      <WeeklyReportTab />
    </TestWrapper>
  );

describe('WeeklyReportTab', () => {
  beforeEach(() => {
    useWeeklyReports.mockReturnValue({ data: [], isLoading: false, isFetching: false, refetch: vi.fn(), error: null });
  });

  it('renders the error card when its own query fails', () => {
    useWeeklyReports.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
      error: new Error('boom'),
    });

    renderTab();

    expect(screen.getByTestId('weekly-report-error')).toBeTruthy();
  });

  it('does not render the error card when its query succeeded', () => {
    renderTab();

    expect(screen.queryByTestId('weekly-report-error')).toBeNull();
  });
});
