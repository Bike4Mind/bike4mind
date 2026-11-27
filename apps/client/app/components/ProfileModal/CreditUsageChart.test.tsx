import { cloneElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import dayjs from 'dayjs';
import { getThemeConfig } from '@client/app/utils/themes';
import { CreditUsageChart, CreditUsageTooltip, isDayTick, toRows, type CreditSeries } from './CreditUsageChart';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
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

const series: CreditSeries[] = [
  {
    id: 'usage',
    color: '#0b6bcb',
    data: [
      { x: '2026-11-02', y: 40 },
      { x: '2026-11-01', y: 120 },
      { x: '2026-11-03', y: 75 },
    ],
  },
  {
    id: 'purchases',
    color: '#1f7a1f',
    data: [
      { x: '2026-11-01', y: 0 },
      { x: '2026-11-03', y: 200 },
    ],
  },
];

describe('toRows', () => {
  it('merges the series into one row per day, oldest first', () => {
    expect(toRows(series)).toEqual([
      { x: '2026-11-01', usage: 120, purchases: 0 },
      { x: '2026-11-02', usage: 40 },
      { x: '2026-11-03', usage: 75, purchases: 200 },
    ]);
  });
});

describe('isDayTick', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  const ticksFrom = (everyDays: number) => {
    const days = Array.from({ length: 73 }, (_, i) => dayjs('2026-10-20').add(i, 'day').format('YYYY-MM-DD'));
    return days.filter(day => isDayTick(day, everyDays));
  };

  // Expected values are the ticks @nivo/scales 0.99 picked for `every N days` on a local-time day scale.
  it.each([
    [7, ['10-22', '10-29', '11-05', '11-12', '11-19', '11-26', '12-03', '12-10', '12-17', '12-24', '12-31']],
    [14, ['10-22', '11-05', '11-19', '12-03', '12-17', '12-31']],
    [30, ['11-03', '12-03']],
  ])('ticks every %s days on the same days as before in America/Chicago', (everyDays, expected) => {
    process.env.TZ = 'America/Chicago';
    expect(ticksFrom(everyDays)).toEqual(expected.map(day => `2026-${day}`));
  });

  it.each([
    [7, ['10-23', '10-30', '11-06', '11-13', '11-20', '11-27', '12-04', '12-11', '12-18', '12-25']],
    [14, ['10-23', '11-06', '11-20', '12-04', '12-18']],
    [30, ['11-04', '12-04']],
  ])('ticks every %s days on the same days as before in Asia/Tokyo', (everyDays, expected) => {
    process.env.TZ = 'Asia/Tokyo';
    expect(ticksFrom(everyDays)).toEqual(expected.map(day => `2026-${day}`));
  });

  it('ticks every day at a one-day interval', () => {
    expect(ticksFrom(1)).toHaveLength(73);
  });
});

describe('CreditUsageChart', () => {
  const renderChart = (pointSize = 8) =>
    render(
      <CreditUsageChart series={series} yLegend="Credits" xLegend="Date" tickEveryDays={1} pointSize={pointSize} />,
      {
        wrapper: TestWrapper,
      }
    );
  const tickLabels = (axis: 'x' | 'y') =>
    [
      ...screen
        .getByTestId('credit-usage-chart')
        .querySelectorAll(`.recharts-${axis}Axis-tick-labels .recharts-cartesian-axis-tick-value`),
    ].map(tick => tick.textContent);

  it('labels both axes and formats the day ticks as MMM DD', () => {
    renderChart();

    const chart = screen.getByTestId('credit-usage-chart');
    expect(within(chart).getByText('Date')).toBeInTheDocument();
    expect(within(chart).getByText('Credits')).toBeInTheDocument();
    expect(tickLabels('x')).toEqual(['Nov 01', 'Nov 02', 'Nov 03']);
    expect(tickLabels('y')).toEqual(['0', '50', '100', '150', '200']);
  });

  it('paints the first series on top', () => {
    renderChart();

    const curves = screen.getByTestId('credit-usage-chart').querySelectorAll('.recharts-area-curve');
    expect([...curves].map(curve => curve.getAttribute('stroke'))).toEqual(['#1f7a1f', '#0b6bcb']);
  });

  it('draws points in each series color, and none when the point size is 0', () => {
    const { unmount } = renderChart();
    const dots = screen.getByTestId('credit-usage-chart').querySelectorAll('.recharts-area-dot');
    expect(dots).toHaveLength(5);
    expect(dots[0]).toHaveAttribute('r', '4');
    unmount();

    renderChart(0);
    expect(screen.getByTestId('credit-usage-chart').querySelectorAll('.recharts-area-dot')).toHaveLength(0);
  });
});

describe('CreditUsageTooltip', () => {
  it('dates the hovered day and names each series the way the picker does', () => {
    const row = { x: '2026-11-03', referral_rewards: 6000, credits_added: 0 };
    render(
      <CreditUsageTooltip
        active
        payload={[
          { dataKey: 'referral_rewards', value: 6000, payload: row },
          { dataKey: 'credits_added', value: 0, payload: row },
        ]}
      />,
      { wrapper: TestWrapper }
    );

    const tooltip = screen.getByTestId('credit-usage-chart-tooltip');
    expect(tooltip).toHaveTextContent('Nov 3, 2026');
    const lines = within(tooltip).getAllByText(/:/);
    expect(lines[0]).toHaveTextContent(`Referral rewards: ${(6000).toLocaleString()} credits.credits`);
    expect(lines[1]).toHaveTextContent('Credits Added: 0 credits.credits');
    expect(screen.queryByText(/referral_rewards|credits_added/)).toBeNull();
  });

  it('renders nothing when inactive', () => {
    render(<CreditUsageTooltip active={false} payload={[]} />, { wrapper: TestWrapper });

    expect(screen.queryByTestId('credit-usage-chart-tooltip')).not.toBeInTheDocument();
  });
});
