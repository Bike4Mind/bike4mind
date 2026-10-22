import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider } from '@mui/joy';
import { describe, expect, it, vi } from 'vitest';
import { OverviewTab } from './OverviewTab';

vi.mock('./UsageBySourceCard', () => ({ UsageBySourceCard: () => null }));
vi.mock('recharts', () => ({
  ResponsiveContainer: () => null,
  BarChart: () => null,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
  PieChart: () => null,
  Pie: () => null,
  Cell: () => null,
  LineChart: () => null,
  Line: () => null,
}));

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
