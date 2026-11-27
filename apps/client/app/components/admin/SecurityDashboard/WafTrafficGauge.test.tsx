import { cloneElement, type ReactElement, type ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { WafTrafficGauge } from './WafTrafficGauge';

// ResponsiveContainer measures 0x0 in jsdom and renders no children; give the chart a fixed size.
vi.mock('recharts', async importOriginal => ({
  ...(await importOriginal<typeof import('recharts')>()),
  ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) =>
    cloneElement(children, { width: 130, height: 130 }),
}));

const theme = extendTheme({ ...getThemeConfig() });
const palette = theme.colorSchemes.light.palette;
const wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={theme} defaultMode="light">
    {children}
  </CssVarsProvider>
);

const sectorFills = (testId: string) =>
  [...screen.getByTestId(testId).querySelectorAll('.recharts-pie-sector path')].map(path => path.getAttribute('fill'));

describe('WafTrafficGauge', () => {
  it('shows each share of the total with its count, counted requests included in the total', () => {
    render(<WafTrafficGauge allowed={750} blocked={200} counted={50} />, { wrapper });

    expect(screen.getByTestId('waf-gauge-allowed-donut-rate')).toHaveTextContent('75.0%');
    expect(screen.getByTestId('waf-gauge-allowed-donut-count')).toHaveTextContent('750 req');
    expect(screen.getByTestId('waf-gauge-blocked-donut-rate')).toHaveTextContent('20.0%');
    expect(screen.getByTestId('waf-gauge-blocked-donut-count')).toHaveTextContent('200 req');
    expect(screen.getByTestId('waf-gauge-total')).toHaveTextContent((1000).toLocaleString());
  });

  it('fills each donut in its own color over the neutral track', () => {
    render(<WafTrafficGauge allowed={750} blocked={200} counted={50} />, { wrapper });

    expect(sectorFills('waf-gauge-allowed-donut-chart')).toEqual([palette.success[500], palette.neutral[200]]);
    expect(sectorFills('waf-gauge-blocked-donut-chart')).toEqual([palette.danger[500], palette.neutral[200]]);
  });

  it('draws a bare track and says No data when there is no traffic', () => {
    render(<WafTrafficGauge allowed={0} blocked={0} counted={0} />, { wrapper });

    expect(sectorFills('waf-gauge-allowed-donut-chart')).toEqual([palette.neutral[200]]);
    expect(screen.queryByTestId('waf-gauge-allowed-donut-rate')).not.toBeInTheDocument();
    expect(screen.getAllByText('No data')).toHaveLength(2);
    expect(screen.getByTestId('waf-gauge-total')).toHaveTextContent('0');
  });
});
