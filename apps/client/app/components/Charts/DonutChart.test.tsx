import { cloneElement, type ReactElement, type ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { DonutChart, DonutTooltip } from './DonutChart';

// ResponsiveContainer measures 0x0 in jsdom and renders no children; give the chart a fixed size.
vi.mock('recharts', async importOriginal => ({
  ...(await importOriginal<typeof import('recharts')>()),
  ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) =>
    cloneElement(children, { width: 500, height: 300 }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const data = [
  { id: 'gpt-4o', label: 'GPT-4o', value: 60 },
  { id: 'claude', label: 'Claude', value: 38 },
  { id: 'tiny', label: 'Tiny', value: 1 },
];

const margin = { top: 20, right: 80, bottom: 20, left: 80 };

describe('DonutChart', () => {
  it('fills each slice from the category palette in data order with a darker outline', () => {
    render(<DonutChart testId="donut" data={data} margin={margin} />, { wrapper: TestWrapper });

    const sectors = screen.getByTestId('donut').querySelectorAll('.recharts-pie-sector path');
    expect([...sectors].map(sector => sector.getAttribute('fill'))).toEqual(['#e8c1a0', '#f47560', '#f1e15b']);
    expect(sectors[0]).toHaveAttribute('stroke', '#d8b495');
  });

  it('puts the value inside and the label outside each slice, skipping slices under 10 degrees', () => {
    render(<DonutChart testId="donut" data={data} margin={margin} />, { wrapper: TestWrapper });

    const chart = screen.getByTestId('donut');
    expect(within(chart).getByText('60')).toBeInTheDocument();
    expect(within(chart).getByText('GPT-4o')).toBeInTheDocument();
    expect(within(chart).getByText('38')).toBeInTheDocument();
    expect(within(chart).getByText('Claude')).toBeInTheDocument();
    expect(within(chart).queryByText('Tiny')).not.toBeInTheDocument();
    expect(within(chart).queryByText('1')).not.toBeInTheDocument();
  });

  it('anchors labels away from the center on each side', () => {
    render(<DonutChart testId="donut" data={data} margin={margin} />, { wrapper: TestWrapper });

    // The first slice runs clockwise from 12 o'clock, so its label sits on the right.
    expect(screen.getByText('GPT-4o')).toHaveAttribute('text-anchor', 'start');
    expect(screen.getByText('Claude')).toHaveAttribute('text-anchor', 'end');
  });
});

describe('DonutTooltip', () => {
  it('shows the id and value with the slice color by default', () => {
    render(<DonutTooltip active payload={[{ payload: data[1] }]} data={data} testId="donut-tooltip" />, {
      wrapper: TestWrapper,
    });

    expect(screen.getByTestId('donut-tooltip')).toHaveTextContent('claude: 38');
  });

  it('hands the datum and its slice color to a custom renderer', () => {
    const renderTooltip = vi.fn(() => <span data-testid="custom">custom</span>);
    render(
      <DonutTooltip
        active
        payload={[{ payload: data[1] }]}
        data={data}
        testId="donut-tooltip"
        renderTooltip={renderTooltip}
      />,
      { wrapper: TestWrapper }
    );

    expect(screen.getByTestId('custom')).toBeInTheDocument();
    expect(screen.queryByTestId('donut-tooltip')).not.toBeInTheDocument();
    expect(renderTooltip).toHaveBeenCalledWith(data[1], '#f47560');
  });

  it('renders nothing when inactive', () => {
    render(<DonutTooltip active={false} payload={[{ payload: data[1] }]} data={data} testId="donut-tooltip" />, {
      wrapper: TestWrapper,
    });

    expect(screen.queryByTestId('donut-tooltip')).not.toBeInTheDocument();
  });
});
