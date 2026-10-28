import React, { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import dayjs from 'dayjs';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * Real hooks and react-query, with only the network mocked: each tab view must send its own
 * request and nothing else, and a Daily Report range change must survive its own load.
 */
const fetchCounterLogs = vi.hoisted(() => vi.fn());
vi.mock('@client/app/utils/userAPICalls', () => ({ fetchCounterLogs }));
vi.mock('@client/app/utils/organizationAPICalls', () => ({ useGetAllOrganizations: () => ({ data: [] }) }));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

import AnalyticsTab from './index';
import { useAnalyticsStore } from './store';
import { AnalyticsSubTab } from './types';
import { getPresetRange } from './dateRange';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderAnalytics = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <CssVarsProvider theme={appTheme}>
          <AnalyticsTab />
        </CssVarsProvider>
      </QueryClientProvider>
    </StrictMode>
  );
};

const daysAgo = (days: number) => dayjs().subtract(days, 'day').format('YYYY-MM-DD');
const requests = () => fetchCounterLogs.mock.calls.map(([params]) => params);

describe('AnalyticsTab requests', () => {
  beforeEach(() => {
    fetchCounterLogs.mockReset();
    fetchCounterLogs.mockImplementation(async (params: { startDate: string }) => ({
      reports: [{ date: params.startDate, report: `Report from ${params.startDate}` }],
      logs: [],
      total: 0,
    }));
    useAnalyticsStore.setState({ activeSubTab: AnalyticsSubTab.UserActivity, dateFilters: getPresetRange(7) });
  });

  it('opening the Daily Report tab sends exactly one daily report request and no User Activity request', async () => {
    useAnalyticsStore.setState({ activeSubTab: AnalyticsSubTab.DailyReport });

    renderAnalytics();

    await screen.findAllByText(/^Report for /);
    expect(requests()).toEqual([{ startDate: daysAgo(6), endDate: daysAgo(0), report: true, includeInsights: true }]);
  });

  it('opening the Weekly Report tab sends nothing until a week is chosen', async () => {
    useAnalyticsStore.setState({ activeSubTab: AnalyticsSubTab.WeeklyReport });

    renderAnalytics();

    await screen.findByText('Select one or more weeks to view reports');
    expect(fetchCounterLogs).not.toHaveBeenCalled();
  });

  it('keeps "Last 30 Days" on the Daily Report tab after the reports load', async () => {
    useAnalyticsStore.setState({ activeSubTab: AnalyticsSubTab.DailyReport });
    renderAnalytics();
    await screen.findAllByText(/^Report for /);

    fireEvent.click(screen.getByTestId('date-filter-preset-30-btn'));

    await screen.findByText(`Report for ${daysAgo(29)}`);
    expect(screen.getByTestId('date-filter-start-input')).toHaveValue(daysAgo(29));
    expect(screen.getByTestId('date-filter-end-input')).toHaveValue(daysAgo(0));
    expect(screen.getByTestId('date-filter-preset-30-btn')).toHaveAttribute('aria-pressed', 'true');
    // The Daily range is the tab's own; the User Activity range in the shared store is untouched.
    expect(useAnalyticsStore.getState().dateFilters).toEqual(getPresetRange(7));
    await waitFor(() => expect(requests().every(params => params.report === true)).toBe(true));
  });
});
