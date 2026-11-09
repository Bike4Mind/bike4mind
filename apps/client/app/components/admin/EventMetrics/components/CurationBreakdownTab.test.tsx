import { CssVarsProvider } from '@mui/joy';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChartData } from '../utils/chartDataProcessor';
import { adminChartSeries } from '../utils/chartTheme';
import { chartColorReport, chartFills } from '../utils/chartTestUtils';
import { CurationBreakdownTab } from './CurationBreakdownTab';

vi.mock('recharts', async () => (await import('../utils/chartTestUtils')).recordingRecharts);

const chartData = (curationBreakdown: ChartData['curationBreakdown']): ChartData => ({
  timeSeriesData: [],
  categoryBreakdown: [],
  topEvents: [],
  eventTrends: [],
  categoryDistribution: [],
  userActivity: [],
  curationBreakdown,
});

describe('CurationBreakdownTab', () => {
  it('draws both breakdowns from admin tokens, leaving no recharts hex default', () => {
    const { container } = render(
      <CssVarsProvider>
        <CurationBreakdownTab
          chartData={chartData([
            {
              fileType: 'pdf',
              count: 3,
              curationType: { transcript: 2, executive_summary: 1 },
              exportFormat: { markdown: 1, txt: 1, html: 1 },
            },
          ])}
          emptyAction={null}
        />
      </CssVarsProvider>
    );
    expect(chartColorReport(container)).toEqual({ hex: [], unset: [] });
    expect(chartFills(container, 'Bar')).toEqual([...adminChartSeries(2), ...adminChartSeries(3)]);
  });

  it('shows an empty state with the given next step when nothing was curated', () => {
    const onRefresh = vi.fn();
    render(
      <CssVarsProvider>
        <CurationBreakdownTab
          chartData={chartData([])}
          emptyAction={
            <button type="button" data-testid="curation-refresh-btn" onClick={onRefresh}>
              Refresh metrics
            </button>
          }
        />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('admin-empty-state')).toHaveTextContent('No curation events yet');
    fireEvent.click(screen.getByTestId('curation-refresh-btn'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
