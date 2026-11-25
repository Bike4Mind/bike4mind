import { CssVarsProvider } from '@mui/joy';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChartData } from '../EventMetrics/utils/chartDataProcessor';
import { CHART_BAD, CHART_GOOD } from '../EventMetrics/utils/chartTheme';
import { chartColorReport, chartFills } from '../EventMetrics/utils/chartTestUtils';
import { SlackMetricsTab } from './SlackMetricsTab';

vi.mock('recharts', async () => (await import('../EventMetrics/utils/chartTestUtils')).recordingRecharts);

const chartData = (
  exportStatus: { success: number; failed: number },
  agentDistribution: Record<string, number> = { helper: 3, analyst: 1 },
  exportFormats = { json: 1, csv: 1, markdown: 0 },
  eventsByType: Record<string, number> = { 'slack.message': 4, 'slack.export': 2 }
): ChartData => ({
  timeSeriesData: [],
  categoryBreakdown: [],
  topEvents: [],
  eventTrends: [],
  categoryDistribution: [],
  userActivity: [],
  slackMetrics: {
    eventsByType,
    exportFormats,
    exportStatus,
    agentDistribution,
    intentDistribution: { question: 2, export: 2 },
  },
});

const renderTab = (data: ChartData) =>
  render(
    <CssVarsProvider>
      <SlackMetricsTab chartData={data} filtered={false} emptyAction={null} />
    </CssVarsProvider>
  ).container;

describe('SlackMetricsTab colors', () => {
  it('draws every chart from admin tokens, leaving no recharts hex default', () => {
    expect(chartColorReport(renderTab(chartData({ success: 3, failed: 1 })))).toEqual({ hex: [], unset: [] });
  });

  it('colors the export status slices by their status, even when one count is zero', () => {
    const fills = (exportStatus: { success: number; failed: number }) =>
      chartFills(renderTab(chartData(exportStatus)), 'Cell').filter(fill => fill === CHART_GOOD || fill === CHART_BAD);
    expect(fills({ success: 3, failed: 1 })).toEqual([CHART_GOOD, CHART_BAD]);
    expect(fills({ success: 0, failed: 2 })).toEqual([CHART_BAD]);
  });
});

describe('SlackMetricsTab sections', () => {
  it('captions the export success rate from both counts', () => {
    renderTab(chartData({ success: 3, failed: 1 }));
    expect(screen.getByTestId('slack-export-success-caption')).toHaveTextContent('75% of 4 exports succeeded');
    expect(screen.getByTestId('slack-agents-caption')).toHaveTextContent('helper is the most common agent (3 of 4)');
  });

  it('shows a notice for an empty series instead of a blank chart', () => {
    renderTab(chartData({ success: 0, failed: 0 }, {}));
    expect(screen.getByTestId('slack-agents')).toHaveTextContent('No agent usage recorded');
    expect(screen.getByTestId('slack-export-success')).toHaveTextContent('No exports recorded');
    expect(screen.queryByTestId('slack-agents-table-toggle-btn')).toBeNull();
    expect(screen.getByTestId('slack-activity-table-toggle-btn')).toBeInTheDocument();
  });

  it('shows the export formats notice when every format count is zero', () => {
    renderTab(chartData({ success: 0, failed: 0 }, undefined, { json: 0, csv: 0, markdown: 0 }));
    expect(screen.getByTestId('slack-export-formats')).toHaveTextContent('No exports recorded');
    expect(screen.queryByTestId('slack-export-formats-caption')).toBeNull();
  });

  it('pluralizes the activity caption by count', () => {
    renderTab(chartData({ success: 1, failed: 0 }, undefined, undefined, { 'slack.message': 1 }));
    expect(screen.getByTestId('slack-activity-caption')).toHaveTextContent('1 event across 1 event type');
    expect(screen.getByTestId('slack-activity-caption')).not.toHaveTextContent('events');
  });
});
