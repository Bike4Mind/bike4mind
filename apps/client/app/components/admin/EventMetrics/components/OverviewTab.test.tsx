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
    fireEvent.click(screen.getByRole('button', { name: 'About Events Over Time' }));
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
