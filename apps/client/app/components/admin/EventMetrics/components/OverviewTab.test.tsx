import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider } from '@mui/joy';
import { describe, expect, it, vi } from 'vitest';
import { CHART_ACCENT, adminChartSeries } from '../utils/chartTheme';
import { chartColorReport, chartFills } from '../utils/chartTestUtils';
import { OverviewTab } from './OverviewTab';

vi.mock('./UsageBySourceCard', () => ({ UsageBySourceCard: () => null }));
vi.mock('recharts', async () => (await import('../utils/chartTestUtils')).recordingRecharts);

describe('OverviewTab coverage help', () => {
  it.each([
    { complete: true, expected: 'Every date is included', excluded: 'Dates with no loaded events are omitted' },
    { complete: undefined, expected: 'Dates with no loaded events are omitted', excluded: 'Every date is included' },
  ])('explains the correct coverage for complete=$complete', async ({ complete, expected, excluded }) => {
    render(
      <CssVarsProvider>
        <OverviewTab
          chartData={{ timeSeriesData: [], categoryBreakdown: [], topEvents: [] }}
          isCompleteWindow={complete}
        />
      </CssVarsProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'About Events over time' }));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent(expected);
    expect(tooltip).not.toHaveTextContent(excluded);
    expect(tooltip).toHaveTextContent(complete ? 'UTC' : "browser's time zone");
  });
});

describe('OverviewTab colors', () => {
  const chartData = {
    timeSeriesData: [{ date: '2026-11-01', count: 3 }],
    categoryBreakdown: [
      { category: 'Session', count: 3, percentage: 60 },
      { category: 'File', count: 1, percentage: 20 },
      { category: 'Other', count: 1, percentage: 20 },
    ],
    topEvents: [{ eventName: 'session.created', count: 3, category: 'Session' }],
  };

  it('draws every chart from admin tokens, leaving no recharts hex default', () => {
    const { container } = render(
      <CssVarsProvider>
        <OverviewTab chartData={chartData} />
      </CssVarsProvider>
    );
    expect(chartColorReport(container)).toEqual({ hex: [], unset: [] });
    expect(chartFills(container, 'Cell')).toEqual(adminChartSeries(3));
    expect(chartFills(container, 'Bar')).toEqual([CHART_ACCENT]);
  });
});

describe('OverviewTab sections', () => {
  const chartData = {
    timeSeriesData: [
      { date: '2026-11-01', count: 3 },
      { date: '2026-11-02', count: 0 },
    ],
    categoryBreakdown: [
      { category: 'Session', count: 3, percentage: 75 },
      { category: 'File', count: 1, percentage: 25 },
    ],
    topEvents: [
      { eventName: 'session.created', count: 3, category: 'Session' },
      { eventName: 'file.uploaded', count: 1, category: 'File' },
    ],
  };
  const renderTab = (data = chartData) =>
    render(
      <CssVarsProvider>
        <OverviewTab chartData={data} showUsageBySource={false} />
      </CssVarsProvider>
    );

  it('counts the whole window as days only when every date in it is present', () => {
    render(
      <CssVarsProvider>
        <OverviewTab chartData={chartData} showUsageBySource={false} isCompleteWindow />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('overview-events-over-time-caption')).toHaveTextContent('3 events across 2 days');
    expect(screen.getByTestId('overview-events-over-time-caption')).not.toHaveTextContent('active');
  });

  it('sums each chart into its caption', () => {
    renderTab();
    expect(screen.getByTestId('overview-events-over-time-caption')).toHaveTextContent('3 events across 2 active days');
    expect(screen.getByTestId('overview-events-by-category-caption')).toHaveTextContent(
      'Session is the largest category with 3 events'
    );
    expect(screen.getByTestId('overview-top-events-caption')).toHaveTextContent('session.created is the most recorded');
  });

  it('shows the plotted values as a table on request', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('overview-top-events-table-toggle-btn'));
    const table = screen.getByTestId('overview-top-events-table');
    expect(table).toHaveTextContent('session.created');
    expect(table).toHaveTextContent('file.uploaded');
  });

  it('shows a notice without a table toggle when a series is empty', () => {
    renderTab({ ...chartData, topEvents: [] });
    expect(screen.getByTestId('overview-top-events')).toHaveTextContent('No events in this report');
    expect(screen.queryByTestId('overview-top-events-table-toggle-btn')).toBeNull();
    expect(screen.getByTestId('overview-events-over-time-table-toggle-btn')).toBeInTheDocument();
  });
});
