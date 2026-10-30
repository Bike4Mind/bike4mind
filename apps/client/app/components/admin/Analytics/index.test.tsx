import type { ReactNode } from 'react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import type { AnalyticsOverview } from '@client/app/utils/analyticsOverview';
import { parseAdminSearch } from '../adminTabParams';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get } }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));

import AnalyticsTab from './index';
import { readAnalyticsFilters, writeAnalyticsFilters } from './analyticsTabSearch';

const theme = extendTheme({ ...getThemeConfig() });

const overview = (patch: Partial<AnalyticsOverview> = {}): AnalyticsOverview => ({
  window: {
    range: '28d',
    from: '2026-05-19',
    to: '2026-06-15',
    today: '2026-06-15',
    partialDay: '2026-06-15',
    completeDays: 27,
    previous: { from: '2026-04-22', to: '2026-05-18' },
    bucket: 'day',
  },
  signupsMode: 'legit',
  lastUpdated: '2026-06-15T04:10:00.000Z',
  stale: false,
  missingDays: [],
  stats: {
    mau: { value: 112, previous: 100 },
    avgDau: { value: 20, previous: 25 },
    stickiness: { value: 17.9, previous: 25 },
    newSignups: { value: 40, previous: 40, suspected: 7 },
  },
  activeUsers: {
    days: [
      { day: '2026-06-14', dau: 20, wau: 60, mau: 112, partial: false, previousMau: 100 },
      { day: '2026-06-15', dau: 4, wau: 61, mau: 113, partial: true, previousMau: 101 },
    ],
    bySource: [
      { day: '2026-06-14', partial: false, counts: { web: 30 } },
      { day: '2026-06-15', partial: true, counts: { web: 3 } },
    ],
    sources: ['web'],
  },
  signups: {
    buckets: [
      { start: '2026-06-14', end: '2026-06-15', legit: 3, suspected: 1, unclassified: 0, partial: false },
      { start: '2026-06-15', end: '2026-06-16', legit: 0, suspected: 0, unclassified: 2, partial: true },
    ],
    totals: { legit: 3, suspected: 1, unclassified: 2 },
    bySignal: [{ signal: 'domainBurst', count: 1 }],
  },
  ...patch,
});

async function renderPage(url: string) {
  const root = createRootRoute();
  const admin = createRoute({
    getParentRoute: () => root,
    path: '/admin',
    validateSearch: parseAdminSearch,
    component: AnalyticsTab,
  });
  const router = createRouter({
    routeTree: root.addChildren([admin]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  await router.load();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
  render(<RouterProvider router={router} />, { wrapper: Wrapper });
  return router;
}

const lastParams = () => mocks.get.mock.calls.at(-1)?.[1]?.params;

beforeEach(() => {
  mocks.get.mockReset();
  mocks.get.mockResolvedValue({ data: overview() });
});

describe('analytics URL state', () => {
  it('reads defaults and drops unknown values', () => {
    expect(readAnalyticsFilters({})).toEqual({ range: '28d', compare: 'prev', signups: 'legit' });
    expect(readAnalyticsFilters({ range: '1y', compare: 'x', signups: 'bots', from: '2026-01-01' })).toEqual({
      range: '28d',
      compare: 'prev',
      signups: 'legit',
    });
  });

  it('round-trips a custom view and leaves defaults out of the URL', () => {
    const query = { range: 'custom', from: '2026-01-01', to: '2026-01-31', compare: 'off', signups: 'all' } as const;
    expect(readAnalyticsFilters(writeAnalyticsFilters(query))).toEqual(query);
    expect(writeAnalyticsFilters({ range: '28d', compare: 'prev', signups: 'legit' })).toEqual({
      range: '',
      from: '',
      to: '',
      compare: '',
      signups: '',
    });
  });
});

describe('AnalyticsTab', () => {
  it('requests the view a deep link describes', async () => {
    await renderPage('/admin?tab=analytics&range=90d&compare=off&signups=all');
    await screen.findByText('Active users (MAU)');
    expect(lastParams()).toEqual({ range: '90d', compare: 'off', signups: 'all' });
    expect(screen.getByTestId('analytics-range-90d')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('analytics-compare-off')).toHaveAttribute('aria-pressed', 'true');
  });

  it('writes toolbar changes to the URL and refetches with them', async () => {
    const router = await renderPage('/admin?tab=analytics');
    await screen.findByText('Active users (MAU)');
    expect(lastParams()).toEqual({ range: '28d', compare: 'prev', signups: 'legit' });

    fireEvent.click(screen.getByTestId('analytics-range-7d'));
    await waitFor(() => expect(router.state.location.search.range).toBe('7d'));
    fireEvent.click(screen.getByTestId('analytics-signups-mode-all'));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ tab: 'analytics', range: '7d', signups: 'all' })
    );
    await waitFor(() => expect(lastParams()).toEqual({ range: '7d', compare: 'prev', signups: 'all' }));

    fireEvent.click(screen.getByTestId('analytics-range-28d'));
    await waitFor(() => expect(router.state.location.search.range).toBeUndefined());
  });

  it('seeds a custom range from the range on screen', async () => {
    const router = await renderPage('/admin?tab=analytics');
    await screen.findByText('Active users (MAU)');
    fireEvent.click(screen.getByTestId('analytics-range-custom'));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ range: 'custom', start: '2026-05-19', end: '2026-06-15' })
    );
    expect(screen.getByLabelText('Start date (UTC)')).toHaveValue('2026-05-19');
  });

  it('does not query an inverted custom range and says why', async () => {
    await renderPage('/admin?tab=analytics&range=custom&start=2026-06-10&end=2026-06-01');
    expect(await screen.findByTestId('analytics-custom-hint')).toHaveTextContent('on or before');
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('shows the tiles, comparisons, suspected meta and the activation placeholder', async () => {
    await renderPage('/admin?tab=analytics');
    await screen.findByText('Active users (MAU)');
    const strip = screen.getByTestId('admin-stat-strip');
    expect(within(strip).getByText('112')).toBeInTheDocument();
    expect(within(strip).getByText('+12% vs previous 27 days')).toBeInTheDocument();
    expect(within(strip).getByText('-7.1 pts vs previous 27 days')).toBeInTheDocument();
    expect(within(strip).getByText(/7 suspected/)).toBeInTheDocument();
    expect(within(strip).getByText('Coming soon')).toBeInTheDocument();
    expect(screen.getByTestId('analytics-last-updated')).toHaveTextContent('Last updated');
    expect(screen.getByTestId('analytics-footer')).toHaveTextContent(
      'Counts exclude staff, system and test accounts. Days are UTC.'
    );
    expect(screen.getByTestId('analytics-active-users-chart')).toHaveAttribute('aria-label');
  });

  it('shows skeletons while loading', async () => {
    mocks.get.mockReturnValue(new Promise(() => {}));
    await renderPage('/admin?tab=analytics');
    expect(await screen.findByTestId('analytics-active-users-skeleton')).toBeInTheDocument();
    expect(screen.getByTestId('analytics-signups-skeleton')).toBeInTheDocument();
    expect(screen.getAllByTestId('analytics-stat-skeleton')).toHaveLength(5);
  });

  it('shows an error with Try again in each section and recovers', async () => {
    mocks.get.mockRejectedValueOnce(new Error('boom'));
    await renderPage('/admin?tab=analytics');
    const retries = await screen.findAllByTestId('admin-error-retry-btn');
    expect(retries).toHaveLength(2);
    fireEvent.click(retries[0]);
    expect(await screen.findByText('Active users (MAU)')).toBeInTheDocument();
  });

  it('offers the last 90 days when the range is empty', async () => {
    const empty = overview();
    empty.activeUsers.days = empty.activeUsers.days.map(day => ({ ...day, dau: 0 }));
    empty.signups.totals = { legit: 0, suspected: 0, unclassified: 0 };
    mocks.get.mockResolvedValue({ data: empty });
    const router = await renderPage('/admin?tab=analytics');
    expect(await screen.findAllByText('No activity in this range')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('analytics-active-users-show-90d-btn'));
    await waitFor(() => expect(router.state.location.search.range).toBe('90d'));
  });

  it('flags missing rollup days and a stale rollup', async () => {
    mocks.get.mockResolvedValue({ data: overview({ missingDays: ['2026-06-01', '2026-06-02'], stale: true }) });
    await renderPage('/admin?tab=analytics');
    expect(await screen.findByTestId('analytics-missing-banner')).toHaveTextContent(
      'Rollup is missing for 2 days; those days show as gaps.'
    );
    fireEvent.click(screen.getByTestId('analytics-missing-toggle-btn'));
    expect(screen.getByTestId('analytics-missing-days')).toHaveTextContent('2026-06-01, 2026-06-02');
    expect(screen.getByTestId('analytics-stale-chip')).toHaveTextContent('Stale');
  });

  it('drills from a signup bucket into the Users list for its UTC window', async () => {
    const router = await renderPage('/admin?tab=analytics&range=7d');
    await screen.findByText('Active users (MAU)');
    fireEvent.click(screen.getByTestId('analytics-signups-table-toggle-btn'));
    fireEvent.click(await screen.findByTestId('analytics-signups-row-2026-06-14-btn'));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        tab: 'users',
        createdFrom: '2026-06-14T00:00:00.000Z',
        createdTo: '2026-06-15T00:00:00.000Z',
      })
    );
    expect(router.state.location.search.range).toBeUndefined();
  });

  it('lists the signup signals as inline bars', async () => {
    await renderPage('/admin?tab=analytics');
    const signals = await screen.findByTestId('analytics-signup-signals');
    expect(within(signals).getByText('Domain burst')).toBeInTheDocument();
    expect(within(signals).getByTestId('admin-inline-bar')).toBeInTheDocument();
  });
});
