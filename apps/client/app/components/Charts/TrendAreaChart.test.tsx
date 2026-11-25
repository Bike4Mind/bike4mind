import { cloneElement, type ReactElement, type ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { TrendAreaChart, TrendTooltip } from './TrendAreaChart';

// ResponsiveContainer measures 0x0 in jsdom and renders no children; give the chart a fixed size.
vi.mock('recharts', async importOriginal => ({
  ...(await importOriginal<typeof import('recharts')>()),
  ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) =>
    cloneElement(children, { width: 600, height: 300 }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const data = [
  { x: '2026-11-01', y: 108 },
  { x: '2026-11-02', y: 207 },
  { x: '2026-11-03', y: 150 },
];

const renderChart = (props: Partial<React.ComponentProps<typeof TrendAreaChart>> = {}) =>
  render(<TrendAreaChart testId="trend" data={data} color="#0b6bcb" xLegend="Date" yLegend="Avg (ms)" {...props} />, {
    wrapper: TestWrapper,
  });

const tickLabels = (axis: 'x' | 'y') =>
  [
    ...screen
      .getByTestId('trend')
      .querySelectorAll(`.recharts-${axis}Axis-tick-labels .recharts-cartesian-axis-tick-value`),
  ].map(tick => tick.textContent);

describe('TrendAreaChart', () => {
  it('labels both axes', () => {
    renderChart();

    const chart = screen.getByTestId('trend');
    expect(within(chart).getByText('Date')).toBeInTheDocument();
    expect(within(chart).getByText('Avg (ms)')).toBeInTheDocument();
  });

  it('ticks every x value and leaves the y ticks to recharts', () => {
    renderChart();

    expect(tickLabels('x')).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
    expect(tickLabels('y')).toEqual(['90', '120', '150', '180', '210']);
  });

  it('formats ticks with the given formatters', () => {
    renderChart({ formatX: value => value.slice(5), formatY: value => `$${value}` });

    expect(tickLabels('x')).toEqual(['11-01', '11-02', '11-03']);
    expect(tickLabels('y')[0]).toBe('$90');
  });

  it('draws one point per value in the series color, and none when the point size is 0', () => {
    const { unmount } = renderChart();
    const dots = screen.getByTestId('trend').querySelectorAll('.recharts-area-dot');
    expect(dots).toHaveLength(3);
    expect(dots[0]).toHaveAttribute('stroke', '#0b6bcb');
    expect(dots[0]).toHaveAttribute('r', '4');
    unmount();

    renderChart({ pointSize: 0 });
    expect(screen.getByTestId('trend').querySelectorAll('.recharts-area-dot')).toHaveLength(0);
  });

  it('fills the area under the line in the series color', () => {
    renderChart();

    const area = screen.getByTestId('trend').querySelector('.recharts-area-area');
    expect(area).toHaveAttribute('fill', '#0b6bcb');
    expect(area).toHaveAttribute('fill-opacity', '0.15');
  });
});

describe('TrendTooltip', () => {
  it('shows the hovered point as x and y', () => {
    render(<TrendTooltip active payload={[{ payload: data[1] }]} color="#0b6bcb" testId="trend-tooltip" />, {
      wrapper: TestWrapper,
    });

    expect(screen.getByTestId('trend-tooltip')).toHaveTextContent('x: 2026-11-02, y: 207');
  });

  it('renders nothing when inactive', () => {
    render(<TrendTooltip active={false} payload={[{ payload: data[1] }]} color="#0b6bcb" testId="trend-tooltip" />, {
      wrapper: TestWrapper,
    });

    expect(screen.queryByTestId('trend-tooltip')).not.toBeInTheDocument();
  });
});
