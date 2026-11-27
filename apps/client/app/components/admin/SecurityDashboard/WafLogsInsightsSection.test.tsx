import { cloneElement, type ReactElement, type ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import type { SecurityDashboardWafLogsInsightsOverview } from '@client/app/hooks/data/admin';
import { adminChartSeries } from '../EventMetrics/utils/chartTheme';
import { WafLogsInsightsSection } from './WafLogsInsightsSection';

// ResponsiveContainer measures 0x0 in jsdom and renders no children; give the chart a fixed size.
vi.mock('recharts', async importOriginal => ({
  ...(await importOriginal<typeof import('recharts')>()),
  ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) =>
    cloneElement(children, { width: 500, height: 260 }),
}));

const theme = extendTheme({ ...getThemeConfig() });
const wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={theme} defaultMode="light">
    {children}
  </CssVarsProvider>
);

const insights = (
  trafficCharacteristics: SecurityDashboardWafLogsInsightsOverview['trafficCharacteristics']
): SecurityDashboardWafLogsInsightsOverview => ({
  enabled: true,
  stage: 'test',
  range: '24h',
  checkedAt: '2026-01-01T00:00:00Z',
  trafficCharacteristics,
  managedRuleGroups: { rateLimitUsage: { limitPerWindow: 10000, windowSecs: 300, topIps: [] } },
});

const nameTicks = (chart: HTMLElement) =>
  [...chart.querySelectorAll('.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value')].map(tick =>
    // Recharts wraps a long label into one tspan per line, and textContent drops the space between them.
    [...tick.querySelectorAll('tspan')].map(line => line.textContent).join(' ')
  );

describe('WafLogsInsightsSection charts', () => {
  const data = insights({
    topBlockedUris: [
      { name: '/wp-login.php', count: 30 },
      { name: '/.env', count: 12.4 },
      { name: '/admin', count: 3 },
    ],
    topClientIps: [
      { name: 'ZZ 192.0.2.1', count: 900 },
      { name: 'ZZ 192.0.2.2', count: 450 },
    ],
  });

  it('lists blocked URIs largest first, top to bottom, with rounded counts', () => {
    render(<WafLogsInsightsSection data={data} range="24h" />, { wrapper });

    const chart = screen.getByTestId('waf-logs-top-blocked-uris-chart');
    expect(nameTicks(chart)).toEqual(['/wp-login.php', '/.env', '/admin']);
    const bars = [...chart.querySelectorAll('.recharts-bar-rectangle path')];
    expect(bars).toHaveLength(3);
    expect(bars.map(bar => bar.getAttribute('fill'))).toEqual(Array(3).fill(adminChartSeries(2)[0]));
    const widths = bars.map(bar => Number(bar.getAttribute('width')));
    expect(widths[0]).toBeGreaterThan(widths[1]);
    expect(widths[1] / widths[0]).toBeCloseTo(12 / 30, 2);
    expect(within(chart).getByText('Block count')).toBeInTheDocument();
    expect(within(chart).getByText('URI')).toBeInTheDocument();
  });

  it('lists client IPs by location in the second admin series color', () => {
    render(<WafLogsInsightsSection data={data} range="24h" />, { wrapper });

    const chart = screen.getByTestId('waf-logs-top-client-ips-chart');
    expect(nameTicks(chart)).toEqual(['ZZ 192.0.2.1', 'ZZ 192.0.2.2']);
    expect(chart.querySelector('.recharts-bar-rectangle path')).toHaveAttribute('fill', adminChartSeries(2)[1]);
    expect(within(chart).getByText('Requests')).toBeInTheDocument();
    expect(within(chart).getByText('Location \u{2022} IP')).toBeInTheDocument();
  });

  it('says there is no data instead of drawing an empty chart', () => {
    render(<WafLogsInsightsSection data={insights({ topBlockedUris: [], topClientIps: [] })} range="24h" />, {
      wrapper,
    });

    expect(screen.getByTestId('waf-logs-top-blocked-uris-empty')).toBeInTheDocument();
    expect(screen.getByTestId('waf-logs-top-client-ips-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('waf-logs-top-blocked-uris-chart')).not.toBeInTheDocument();
  });
});
