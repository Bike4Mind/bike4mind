import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider } from '@mui/joy';
import { describe, expect, it, vi } from 'vitest';
import { CHART_ACCENT, CHART_MUTED } from '../utils/chartTheme';
import { chartColorReport, chartFills } from '../utils/chartTestUtils';
import { UsageBySourceCard } from './UsageBySourceCard';

vi.mock('../hooks/useUsageBySource', () => ({
  useUsageBySource: () => ({
    isLoading: false,
    isError: false,
    data: {
      buckets: [
        { source: 'badge-button', events: 4, uniqueUsers: 2 },
        { source: 'manual', events: 3, uniqueUsers: 2 },
        { source: 'auto', events: 2, uniqueUsers: 1 },
        { source: 'future-client', events: 1, uniqueUsers: 1 },
        { source: 'web', events: 5, uniqueUsers: 3 },
      ],
    },
  }),
}));

vi.mock('recharts', async () => (await import('../utils/chartTestUtils')).recordingRecharts);

function renderCard() {
  return render(
    <CssVarsProvider>
      <UsageBySourceCard />
    </CssVarsProvider>
  );
}

describe('UsageBySourceCard help', () => {
  it('shows readable source names and explains their recorded values on tap', async () => {
    renderCard();
    const table = screen.getByTestId('usage-by-source-table');
    expect(within(table).getByText('Badge button')).toBeInTheDocument();
    expect(within(table).getByText('Automatic')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'About Badge button' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Opened from a button with a notification count badge. Recorded value: badge-button.'
    );
  });

  it('makes help available on focus and closes it when focus leaves', async () => {
    renderCard();
    const help = screen.getByRole('button', { name: 'About Manual' });
    fireEvent.focus(help);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('An action started by a person');
    expect(help).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id);
    fireEvent.blur(help);
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });

  it('explains unknown sources without inventing a definition', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'About future-client' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('No explanation is available for this value yet.');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Recorded value: future-client.');
  });

  it('keeps tap-opened help readable beyond the default touch dismissal delay', async () => {
    renderCard();
    const help = screen.getByRole('button', { name: 'About Automatic' });
    fireEvent.touchStart(help);
    fireEvent.touchEnd(help);
    fireEvent.click(help);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('triggered automatically');
    await new Promise(resolve => setTimeout(resolve, 1700));
    expect(screen.getByRole('tooltip')).toBeVisible();
  });

  it('distinguishes event share from chart users and explains the non-distinct total', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'About Event share' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'This percentage measures events; the chart shows users per source.'
    );
    fireEvent.blur(screen.getByRole('button', { name: 'About Event share' }));
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'About Total users' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Someone active in two sources contributes two to this total.'
    );
  });

  // fireEvent.click does not move focus, matching WebKit where a tapped button never blurs.
  it('closes tap-opened help on a second tap or a tap elsewhere without relying on blur', async () => {
    renderCard();
    const help = screen.getByRole('button', { name: 'About Manual' });
    fireEvent.click(help);
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
    fireEvent.click(help);
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());

    fireEvent.click(help);
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByTestId('usage-by-source-table'));
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });
});

describe('UsageBySourceCard colors and width', () => {
  it('draws the pie from admin tokens, with known sources on the accent and others muted', () => {
    const { container } = renderCard();
    expect(chartColorReport(container)).toEqual({ hex: [], unset: [] });
    expect(chartFills(container, 'Cell')).toEqual([CHART_MUTED, CHART_MUTED, CHART_MUTED, CHART_MUTED, CHART_ACCENT]);
  });

  it('colors the table swatches like their slices', () => {
    renderCard();
    expect(screen.getByTestId('usage-by-source-swatch-badge-button')).toHaveStyle({ backgroundColor: CHART_MUTED });
    expect(screen.getByTestId('usage-by-source-swatch-web')).toHaveStyle({ backgroundColor: CHART_ACCENT });
  });

  it('lets the table fit its card instead of forcing a 600 px minimum width', () => {
    renderCard();
    const table = within(screen.getByTestId('usage-by-source-table')).getByRole('table');
    expect(getComputedStyle(table).minWidth).not.toBe('600px');
  });
});
