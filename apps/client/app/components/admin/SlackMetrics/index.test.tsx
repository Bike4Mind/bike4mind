import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import dayjs from 'dayjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

const { useEventMetrics, forceRefresh } = vi.hoisted(() => ({ useEventMetrics: vi.fn(), forceRefresh: vi.fn() }));

vi.mock('../EventMetrics/hooks/useEventMetrics', () => ({ useEventMetrics }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));

import SlackMetricsPage from './index';

const theme = extendTheme({ ...getThemeConfig() });
const renderPage = () =>
  render(
    <CssVarsProvider theme={theme}>
      <SlackMetricsPage />
    </CssVarsProvider>
  );

beforeEach(() => {
  forceRefresh.mockReset();
  useEventMetrics.mockReset();
  useEventMetrics.mockReturnValue({
    data: [],
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    forceRefresh,
  });
});

describe('SlackMetricsPage', () => {
  it('opens with the page header, then one wrapping filter row without a category filter', () => {
    renderPage();
    const header = screen.getByTestId('admin-page-header');
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent('Slack metrics');
    expect(header).toHaveTextContent('Usage of the Slack integration: events, agents, intents and exports.');
    const row = screen.getByTestId('event-metrics-filter-row');
    expect(header.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row).toHaveStyle({ flexWrap: 'wrap' });
    expect(within(row).queryByTestId('admin-filter-event-category')).toBeNull();
    expect(screen.queryByRole('button', { name: /apply/i })).toBeNull();
  });

  it('scopes every request to Slack events, including a picked range', async () => {
    renderPage();
    expect(useEventMetrics.mock.calls[0][0]).toEqual({ eventCategoryFilter: 'Slack' });
    fireEvent.click(screen.getByTestId('event-metrics-range-last30days'));
    await waitFor(() =>
      expect(useEventMetrics.mock.calls.at(-1)?.[0]).toMatchObject({
        eventCategoryFilter: 'Slack',
        dateFrom: dayjs().subtract(30, 'days').startOf('day').toISOString(),
      })
    );
  });

  it('shows an empty state with a refresh action when no Slack events loaded', () => {
    renderPage();
    const empty = screen.getByTestId('admin-empty-state');
    expect(empty).toHaveTextContent('No Slack events yet');
    fireEvent.click(within(empty).getByTestId('slack-metrics-empty-refresh-btn'));
    expect(forceRefresh).toHaveBeenCalledTimes(1);
  });
});
