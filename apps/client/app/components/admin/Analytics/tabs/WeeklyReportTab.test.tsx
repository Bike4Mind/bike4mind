import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * useWeeklyReports never rejects - it catches per week and resolves with {error} entries - so
 * the tab's own `error` prop, not the hook's, is the only thing that can reach this branch.
 */
const useWeeklyReports = vi.hoisted(() => vi.fn());
vi.mock('@client/app/hooks/useWeeklyReports', () => ({ useWeeklyReports }));

import { WeeklyReportTab } from './WeeklyReportTab';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('WeeklyReportTab', () => {
  beforeEach(() => {
    useWeeklyReports.mockReturnValue({ data: [], isLoading: false, refetch: vi.fn(), error: null });
  });

  it('renders the error card when the error prop is set', () => {
    render(
      <TestWrapper>
        <WeeklyReportTab loading={false} error={new Error('boom')} onRefresh={vi.fn()} />
      </TestWrapper>
    );

    expect(screen.getByTestId('weekly-report-error')).toBeTruthy();
  });

  it('does not render the error card without an error prop', () => {
    render(
      <TestWrapper>
        <WeeklyReportTab loading={false} onRefresh={vi.fn()} />
      </TestWrapper>
    );

    expect(screen.queryByTestId('weekly-report-error')).toBeNull();
  });
});
