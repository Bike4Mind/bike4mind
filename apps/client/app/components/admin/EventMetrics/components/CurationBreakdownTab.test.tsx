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
          filtered={false}
          emptyAction={null}
        />
      </CssVarsProvider>
    );
    expect(chartColorReport(container)).toEqual({ hex: [], unset: [] });
    expect(chartFills(container, 'Bar')).toEqual([...adminChartSeries(2), ...adminChartSeries(3)]);
  });

  it('says the filters may be why when the page has filters set', () => {
    render(
      <CssVarsProvider>
        <CurationBreakdownTab chartData={chartData([])} filtered emptyAction={null} />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('admin-empty-state')).toHaveTextContent('No curation events in this range');
    expect(screen.getByTestId('admin-empty-state')).not.toHaveTextContent('No curation events yet');
  });

  it('shows an empty state with the given next step when nothing was curated', () => {
    const onRefresh = vi.fn();
    render(
      <CssVarsProvider>
        <CurationBreakdownTab
          chartData={chartData([])}
          filtered={false}
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

  it('captions each breakdown and lists it per file type as a table', () => {
    render(
      <CssVarsProvider>
        <CurationBreakdownTab
          chartData={chartData([
            {
              fileType: 'pdf',
              count: 3,
              curationType: { transcript: 2, executive_summary: 1 },
              exportFormat: { markdown: 1, txt: 0, html: 0 },
            },
            { fileType: 'docx', count: 1, curationType: { transcript: 1, executive_summary: 0 } },
          ])}
          filtered={false}
          emptyAction={null}
        />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('curation-types-caption')).toHaveTextContent('4 curations across 2 file types');
    expect(screen.getByTestId('export-formats-caption')).toHaveTextContent('1 export across 2 file types');
    fireEvent.click(screen.getByTestId('curation-types-table-toggle-btn'));
    expect(screen.getByTestId('curation-types-table')).toHaveTextContent('docx');
  });
  it('shows a notice instead of empty bars for a breakdown with no counts', () => {
    render(
      <CssVarsProvider>
        <CurationBreakdownTab
          chartData={chartData([{ fileType: 'pdf', count: 2, curationType: {}, exportFormat: { markdown: 2 } }])}
          filtered={false}
          emptyAction={null}
        />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('curation-types')).toHaveTextContent('No curations recorded');
    expect(screen.queryByTestId('curation-types-caption')).toBeNull();
    expect(screen.getByTestId('export-formats-caption')).toHaveTextContent('2 exports across 1 file type');
  });
});
