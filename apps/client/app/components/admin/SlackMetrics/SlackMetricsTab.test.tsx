import { CssVarsProvider } from '@mui/joy';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChartData } from '../EventMetrics/utils/chartDataProcessor';
import { CHART_BAD, CHART_GOOD } from '../EventMetrics/utils/chartTheme';
import { chartColorReport, chartFills } from '../EventMetrics/utils/chartTestUtils';
import { SlackMetricsTab } from './SlackMetricsTab';

vi.mock('recharts', async () => (await import('../EventMetrics/utils/chartTestUtils')).recordingRecharts);

const chartData = (exportStatus: { success: number; failed: number }): ChartData => ({
  timeSeriesData: [],
  categoryBreakdown: [],
  topEvents: [],
  eventTrends: [],
  categoryDistribution: [],
  userActivity: [],
  slackMetrics: {
    eventsByType: { 'slack.message': 4, 'slack.export': 2 },
    exportFormats: { json: 1, csv: 1, markdown: 0 },
    exportStatus,
    agentDistribution: { helper: 3, analyst: 1 },
    intentDistribution: { question: 2, export: 2 },
  },
});

const renderTab = (data: ChartData) =>
  render(
    <CssVarsProvider>
      <SlackMetricsTab chartData={data} emptyAction={null} />
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
