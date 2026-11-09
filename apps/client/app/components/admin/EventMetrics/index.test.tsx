import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import dayjs from 'dayjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { parseAdminSearch } from '../adminTabParams';
import { SEARCH_TERM_URL_DEBOUNCE_MS } from '../shared';
import type { EventMetric } from './types';

const { useEventMetrics, forceRefresh } = vi.hoisted(() => ({ useEventMetrics: vi.fn(), forceRefresh: vi.fn() }));

vi.mock('./hooks/useEventMetrics', () => ({ useEventMetrics }));
vi.mock('./UserActivity', () => ({ UserActivityView: () => <div data-testid="user-activity-view" /> }));
vi.mock('./components/OverviewTab', () => ({ OverviewTab: () => <div data-testid="overview-charts" /> }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));

import EventMetricsTab from './index';

const theme = extendTheme({ ...getThemeConfig() });

const metric = (id: string, eventName: string, userId: string, userName: string): EventMetric => ({
  id,
  timestamp: '2026-11-01T10:00:00.000Z',
  eventName,
  eventCategory: 'Session',
  user: { userId, userName, userLevel: 'user' },
  counterValue: 1,
});
const METRICS = [metric('1', 'session.created', 'u1', 'Ada'), metric('2', 'file.uploaded', 'u2', 'Grace')];

const queryResult = (overrides: Record<string, unknown> = {}) => ({
  data: METRICS,
  isLoading: false,
  isFetching: false,
  isError: false,
  error: null,
  forceRefresh,
  ...overrides,
});

const lastFilters = () => useEventMetrics.mock.calls.at(-1)?.[0];

async function renderTab(url: string) {
  const root = createRootRoute();
  const admin = createRoute({
    getParentRoute: () => root,
    path: '/admin',
    validateSearch: parseAdminSearch,
    component: EventMetricsTab,
  });
  const router = createRouter({
    routeTree: root.addChildren([admin]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  await router.load();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })}>
      <CssVarsProvider theme={theme}>
        <RouterProvider router={router} />
      </CssVarsProvider>
    </QueryClientProvider>
  );
  return router;
}

const precedes = (first: Element, second: Element) =>
  Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

beforeEach(() => {
  useEventMetrics.mockReset();
  useEventMetrics.mockReturnValue(queryResult());
  forceRefresh.mockReset();
});

describe('EventMetricsTab views', () => {
  it('opens the By user grid from a deep link', async () => {
    await renderTab('/admin?tab=event-metrics&eventsView=by-user');
    expect(await screen.findByTestId('user-activity-view')).toBeInTheDocument();
    expect(screen.queryByTestId('overview-tab')).toBeNull();
  });

  it('switches between the event charts and the By user grid through the URL', async () => {
    const router = await renderTab('/admin?tab=event-metrics');
    expect(await screen.findByTestId('overview-tab')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('event-metrics-view-by-user'));
    await waitFor(() => expect(router.state.location.search.eventsView).toBe('by-user'));
    expect(await screen.findByTestId('user-activity-view')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('event-metrics-view-events'));
    await waitFor(() => expect(router.state.location.search.eventsView).toBeUndefined());
  });
});

describe('EventMetricsTab page anatomy', () => {
  it.each(['/admin?tab=event-metrics', '/admin?tab=event-metrics&eventsView=by-user'])(
    'opens %s with the page header, then the view switch',
    async url => {
      await renderTab(url);
      const header = await screen.findByTestId('admin-page-header');
      expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent('Event metrics');
      expect(header).toHaveTextContent('Recorded product events by date, category, event and user.');
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      expect(precedes(header, screen.getByTestId('event-metrics-view'))).toBe(true);
    }
  );

  it('puts every filter in one wrapping row under the view switch, with no Apply button or native datetime input', async () => {
    await renderTab('/admin?tab=event-metrics');
    const row = await screen.findByTestId('event-metrics-filter-row');
    expect(row).toHaveStyle({ display: 'flex', flexWrap: 'wrap' });
    expect(precedes(screen.getByTestId('event-metrics-view'), row)).toBe(true);
    expect(within(row).getByTestId('event-metrics-range-all')).toHaveAttribute('aria-pressed', 'true');
    const segments = within(within(row).getByTestId('event-metrics-range')).getAllByRole('button');
    expect(segments.map(segment => segment.dataset.testid)).toEqual([
      'event-metrics-range-last7days',
      'event-metrics-range-last30days',
      'event-metrics-range-last90days',
      'event-metrics-range-all',
    ]);
    expect(segments.map(segment => segment.textContent)).toEqual(['7d', '30d', '90d', 'All time']);
    for (const id of ['event-range', 'event-category', 'event-name', 'event-user']) {
      expect(within(row).getByTestId(`admin-filter-${id}`)).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: /apply/i })).toBeNull();
    expect(document.querySelector('input[type="datetime-local"]')).toBeNull();
    expect(screen.queryByTestId('event-metrics-date-from')).toBeNull();
  });

  it('keeps the tab strip on one line, with plain text labels', async () => {
    await renderTab('/admin?tab=event-metrics');
    const tablist = await screen.findByRole('tablist');
    expect(tablist).toHaveStyle({ flexWrap: 'nowrap', overflowX: 'auto' });
    expect(
      within(tablist)
        .getAllByRole('tab')
        .map(tab => tab.textContent)
    ).toEqual(['Overview', 'Curation breakdown']);
    expect(within(tablist).getByRole('tab', { name: 'Overview' })).toHaveStyle({ whiteSpace: 'nowrap' });
  });

  it('shows the key numbers in one stat strip', async () => {
    await renderTab('/admin?tab=event-metrics');
    const strip = await screen.findByTestId('admin-stat-strip');
    expect(
      within(strip)
        .getAllByTestId('admin-stat-tile')
        .map(tile => tile.textContent)
    ).toEqual(['Total events2', 'Filtered2', 'Unique events2', 'Unique users2']);
  });
});

describe('EventMetricsTab filters', () => {
  it('applies a quick range when it is picked, as one fetch for the whole range', async () => {
    await renderTab('/admin?tab=event-metrics');
    await act(() => new Promise(resolve => setTimeout(resolve, SEARCH_TERM_URL_DEBOUNCE_MS + 50)));
    const callsBefore = useEventMetrics.mock.calls.length;
    fireEvent.click(screen.getByTestId('event-metrics-range-last7days'));
    expect(screen.getByTestId('event-metrics-range-last7days')).toHaveAttribute('aria-pressed', 'true');
    const picked = {
      dateFrom: dayjs().subtract(7, 'days').startOf('day').toISOString(),
      dateTo: dayjs().endOf('day').toISOString(),
    };
    await waitFor(() => expect(lastFilters()).toMatchObject(picked));
    await act(() => new Promise(resolve => setTimeout(resolve, SEARCH_TERM_URL_DEBOUNCE_MS + 50)));
    const fetched = new Set(useEventMetrics.mock.calls.slice(callsBefore).map(([filters]) => JSON.stringify(filters)));
    expect([...fetched]).toEqual([JSON.stringify({}), JSON.stringify(picked)]);
  });

  it('keeps the stat strip and charts on screen with an updating bar while a new range loads', async () => {
    useEventMetrics.mockImplementation((filters: { dateFrom?: string } | undefined) =>
      // What placeholder data gives: the previous metrics stay while the new range is fetched.
      queryResult(filters?.dateFrom ? { isFetching: true } : {})
    );
    await renderTab('/admin?tab=event-metrics');
    expect(await screen.findByTestId('admin-stat-strip')).toBeInTheDocument();
    expect(screen.queryByTestId('event-metrics-updating')).toBeNull();
    fireEvent.click(screen.getByTestId('event-metrics-range-last30days'));
    expect(await screen.findByTestId('event-metrics-updating')).toBeVisible();
    expect(screen.getByTestId('admin-stat-strip')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.queryByTestId('admin-loading-state')).toBeNull();
  });

  it('offers a 90 day range', async () => {
    await renderTab('/admin?tab=event-metrics');
    fireEvent.click(await screen.findByTestId('event-metrics-range-last90days'));
    await waitFor(() =>
      expect(lastFilters()?.dateFrom).toBe(dayjs().subtract(90, 'days').startOf('day').toISOString())
    );
  });

  it('applies custom From and To days once typing settles, not on every keystroke', async () => {
    await renderTab('/admin?tab=event-metrics');
    fireEvent.click(await screen.findByTestId('admin-filter-event-range'));
    fireEvent.click(await screen.findByTestId('admin-filter-event-range-custom'));
    expect(screen.getByTestId('admin-filter-event-range')).toHaveTextContent('Range: Custom');
    // Let the mount's own apply run on real timers before the clock is faked.
    await act(() => new Promise(resolve => setTimeout(resolve, SEARCH_TERM_URL_DEBOUNCE_MS + 50)));
    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByTestId('event-metrics-date-from'), { target: { value: '2026-10-01' } });
      fireEvent.change(screen.getByTestId('event-metrics-date-to'), { target: { value: '2026-10-31' } });
      act(() => vi.advanceTimersByTime(SEARCH_TERM_URL_DEBOUNCE_MS - 1));
      expect(lastFilters()?.dateFrom).toBeUndefined();
      act(() => vi.advanceTimersByTime(1));
      expect(lastFilters()).toMatchObject({
        dateFrom: dayjs('2026-10-01').startOf('day').toISOString(),
        dateTo: dayjs('2026-10-31').endOf('day').toISOString(),
      });
    } finally {
      vi.useRealTimers();
    }
    expect(screen.getByTestId('event-metrics-date-from')).toHaveAttribute('type', 'date');
  });

  it('keeps every other preset in the Range chip and applies its dates, with no segment selected', async () => {
    await renderTab('/admin?tab=event-metrics');
    fireEvent.click(await screen.findByTestId('admin-filter-event-range'));
    const menu = await screen.findByTestId('admin-filter-event-range-menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map(item => item.textContent)
    ).toEqual(['Today', 'Yesterday', 'This month', 'Last month', 'Custom']);
    fireEvent.click(within(menu).getByTestId('admin-filter-event-range-thisMonth'));
    expect(screen.getByTestId('admin-filter-event-range')).toHaveTextContent('Range: This month');
    for (const segment of within(screen.getByTestId('event-metrics-range')).getAllByRole('button')) {
      expect(segment).toHaveAttribute('aria-pressed', 'false');
    }
    await waitFor(() =>
      expect(lastFilters()).toMatchObject({
        dateFrom: dayjs().startOf('month').toISOString(),
        dateTo: dayjs().endOf('month').toISOString(),
      })
    );

    fireEvent.click(screen.getByTestId('admin-filter-clear-event-range-btn'));
    expect(screen.getByTestId('event-metrics-range-all')).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(lastFilters()?.dateFrom).toBeUndefined());
    expect(lastFilters()?.dateTo).toBeUndefined();
  });

  it('applies a picked event and clears every filter back to all time', async () => {
    await renderTab('/admin?tab=event-metrics');
    fireEvent.click(await screen.findByTestId('admin-filter-event-name'));
    fireEvent.click(await screen.findByTestId('admin-filter-event-name-file.uploaded'));
    fireEvent.click(screen.getByTestId('admin-filter-event-range'));
    fireEvent.click(await screen.findByTestId('admin-filter-event-range-yesterday'));
    await waitFor(() => expect(lastFilters()).toMatchObject({ eventFilter: 'file.uploaded' }));
    expect(lastFilters()?.dateFrom).toBeDefined();

    fireEvent.click(screen.getByTestId('event-metrics-clear-filters-btn'));
    expect(screen.getByTestId('event-metrics-range-all')).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(lastFilters()).toEqual(expect.not.objectContaining({ eventFilter: expect.anything() })));
    expect(lastFilters()?.dateFrom).toBeUndefined();
    expect(screen.queryByTestId('event-metrics-clear-filters-btn')).toBeNull();
  });
});

describe('EventMetricsTab states', () => {
  it('shows a loading state in place of the charts on first load', async () => {
    useEventMetrics.mockReturnValue(queryResult({ data: undefined, isLoading: true, isFetching: true }));
    await renderTab('/admin?tab=event-metrics');
    expect(await screen.findByTestId('admin-loading-state')).toHaveTextContent('Loading event metrics');
    expect(screen.queryByTestId('admin-stat-strip')).toBeNull();
    expect(screen.getByTestId('event-metrics-filter-row')).toBeInTheDocument();
  });

  it('shows an error state with a retry instead of empty charts when the first load fails', async () => {
    useEventMetrics.mockReturnValue(
      queryResult({ data: undefined, isError: true, error: new Error('Request failed with status code 500') })
    );
    await renderTab('/admin?tab=event-metrics');
    const error = await screen.findByTestId('admin-error-state');
    expect(error).toHaveTextContent('Event metrics failed to load. Request failed with status code 500');
    expect(screen.queryByTestId('admin-stat-strip')).toBeNull();
    fireEvent.click(within(error).getByTestId('admin-error-retry-btn'));
    expect(forceRefresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes from the page header', async () => {
    await renderTab('/admin?tab=event-metrics');
    const header = await screen.findByTestId('admin-page-header');
    fireEvent.click(within(header).getByTestId('event-metrics-refresh-btn'));
    expect(forceRefresh).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state with a refresh action when no curation events loaded', async () => {
    await renderTab('/admin?tab=event-metrics');
    fireEvent.click(await screen.findByRole('tab', { name: 'Curation breakdown' }));
    const empty = await screen.findByTestId('admin-empty-state');
    expect(empty).toHaveTextContent('No curation events yet');
    fireEvent.click(within(empty).getByTestId('event-metrics-curation-refresh-btn'));
    expect(forceRefresh).toHaveBeenCalledTimes(1);
  });

  it('offers Clear filters instead when the empty curation view may be down to the filters', async () => {
    await renderTab('/admin?tab=event-metrics');
    fireEvent.click(await screen.findByTestId('event-metrics-range-last90days'));
    fireEvent.click(screen.getByRole('tab', { name: 'Curation breakdown' }));
    const empty = await screen.findByTestId('admin-empty-state');
    expect(empty).toHaveTextContent('No curation events in this range');
    expect(within(empty).queryByTestId('event-metrics-curation-refresh-btn')).toBeNull();
    fireEvent.click(within(empty).getByTestId('event-metrics-empty-clear-filters-btn'));
    expect(screen.getByTestId('event-metrics-range-all')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('admin-empty-state')).toHaveTextContent('No curation events yet');
  });
});
