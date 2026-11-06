import { cloneElement, type ReactElement, type ReactNode } from 'react';
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
import type { AnalyticsOverview, AnalyticsTopAccounts } from '@client/app/utils/analyticsOverview';
import { parseAdminSearch } from '../adminTabParams';

const mocks = vi.hoisted(() => {
  const overview = vi.fn();
  const topAccounts = vi.fn();
  const get = vi.fn((url: string, config?: unknown) =>
    url.endsWith('/top-accounts') ? topAccounts(url, config) : overview(url, config)
  );
  return { get, overview, topAccounts, download: vi.fn(), toastError: vi.fn() };
});
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get } }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));
vi.mock('./analyticsExport', () => ({ downloadAnalyticsExport: mocks.download }));
// The cohorts section fetches on its own and is tested in CohortsSection.test.tsx; here only what the page hands it.
vi.mock('./CohortsSection', () => ({
  CohortsSection: ({ signups }: { signups: string }) => <div data-testid="cohorts-stub" data-signups={signups} />,
}));

vi.mock('recharts', async importOriginal => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      cloneElement(children, { width: 600, height: 260 } as Record<string, unknown>),
  };
});

import AnalyticsTab from './index';
import { ActiveUsersTooltip } from './ActiveUsersSection';
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
  accounts: 'external',
  lastUpdated: '2026-06-15T04:10:00.000Z',
  stale: false,
  missingDays: [],
  internalMissingDays: [],
  stats: {
    mau: { value: 112, previous: 100 },
    avgDau: { value: 20, previous: 25 },
    stickiness: { value: 17.9, previous: 25 },
    newSignups: { value: 40, previous: 40, suspected: 7 },
  },
  activeUsers: {
    days: [
      {
        day: '2026-06-14',
        dau: 20,
        wau: 60,
        mau: 112,
        apiDau: 5,
        partial: false,
        previousMau: 100,
        external: { dau: 20, wau: 60, mau: 112 },
        internal: { dau: 3, wau: 5, mau: 9 },
      },
      {
        day: '2026-06-15',
        dau: 4,
        wau: 61,
        mau: 113,
        apiDau: 1,
        partial: true,
        previousMau: 101,
        external: { dau: 4, wau: 61, mau: 113 },
        internal: { dau: 1, wau: 5, mau: 9 },
      },
    ],
    bySource: [
      { day: '2026-06-14', partial: false, counts: { web: 30 } },
      { day: '2026-06-15', partial: true, counts: { web: 3 } },
    ],
    sources: ['web'],
  },
  signups: {
    buckets: [
      { start: '2026-06-14', end: '2026-06-15', legit: 3, suspected: 1, partial: false },
      { start: '2026-06-15', end: '2026-06-16', legit: 0, suspected: 2, partial: true },
    ],
    totals: { legit: 3, suspected: 3 },
    bySignal: [{ signal: 'domainBurst', count: 1 }],
  },
  usage: {
    features: ['chat', 'image_generation', 'other'],
    days: [
      { day: '2026-06-14', partial: false, byFeature: { chat: 25, image_generation: 4, other: 1 }, credits: 300 },
      { day: '2026-06-15', partial: true, byFeature: { chat: 3, image_generation: 0, other: 0 }, credits: 20 },
    ],
    models: [
      { model: 'gpt-4.1', requests: 20, share: 66.67 },
      { model: 'claude-sonnet', requests: 8, share: 26.67 },
    ],
    otherModelRequests: 2,
    totals: { requests: 30, credits: 300 },
    summaryDays: 27,
  },
  ...patch,
});

const topAccounts = (patch: Partial<AnalyticsTopAccounts> = {}): AnalyticsTopAccounts => ({
  covered: { from: '2026-05-19', to: '2026-06-14' },
  missingDays: [],
  users: [
    {
      id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      name: 'Ada',
      plan: 'PaidUser',
      activeDays: 20,
      requests: 90,
      credits: 900,
      share: 60,
      known: true,
    },
    {
      id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
      name: 'Ben',
      plan: 'DemoUser',
      activeDays: 3,
      requests: 10,
      credits: 50,
      share: 6.7,
      // A deleted account: listed, but there is no page to open.
      known: false,
    },
  ],
  orgs: [
    {
      id: 'cccccccccccccccccccccccc',
      name: 'Acme',
      plan: 'Paid',
      activeDays: 22,
      requests: 95,
      credits: 950,
      share: 63,
      known: true,
    },
  ],
  excluded: { suspected: 3, suspended: 1 },
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

const lastParams = () => (mocks.overview.mock.calls.at(-1)?.[1] as { params?: unknown } | undefined)?.params;

beforeEach(() => {
  mocks.get.mockClear();
  mocks.overview.mockReset();
  mocks.overview.mockResolvedValue({ data: overview() });
  mocks.topAccounts.mockReset();
  mocks.topAccounts.mockResolvedValue({ data: topAccounts() });
  mocks.download.mockReset();
  mocks.download.mockResolvedValue(undefined);
  mocks.toastError.mockClear();
});

describe('analytics URL state', () => {
  it('reads defaults and drops unknown values', () => {
    expect(readAnalyticsFilters({})).toEqual({
      range: '28d',
      compare: 'prev',
      signups: 'legit',
      accounts: 'external',
    });
    expect(
      readAnalyticsFilters({ range: '1y', compare: 'x', signups: 'bots', accounts: 'staff', from: '2026-01-01' })
    ).toEqual({
      range: '28d',
      compare: 'prev',
      signups: 'legit',
      accounts: 'external',
    });
  });

  it('round-trips a custom view and leaves defaults out of the URL', () => {
    const query = {
      range: 'custom',
      from: '2026-01-01',
      to: '2026-01-31',
      compare: 'off',
      signups: 'all',
      accounts: 'internal',
    } as const;
    expect(readAnalyticsFilters(writeAnalyticsFilters(query))).toEqual(query);
    expect(writeAnalyticsFilters({ range: '28d', compare: 'prev', signups: 'legit', accounts: 'external' })).toEqual({
      range: '',
      from: '',
      to: '',
      compare: '',
      signups: '',
      accounts: '',
    });
  });
});

describe('AnalyticsTab', () => {
  it('requests the view a deep link describes', async () => {
    await renderPage('/admin?tab=analytics&range=90d&compare=off&signups=all');
    await screen.findByText('Active users (MAU)');
    expect(lastParams()).toEqual({ range: '90d', compare: 'off', signups: 'all', accounts: 'external' });
    expect(screen.getByTestId('analytics-range-90d')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('analytics-compare-off')).toHaveAttribute('aria-pressed', 'true');
  });

  it('writes toolbar changes to the URL and refetches with them', async () => {
    const router = await renderPage('/admin?tab=analytics');
    await screen.findByText('Active users (MAU)');
    expect(lastParams()).toEqual({ range: '28d', compare: 'prev', signups: 'legit', accounts: 'external' });

    fireEvent.click(screen.getByTestId('analytics-range-7d'));
    await waitFor(() => expect(router.state.location.search.range).toBe('7d'));
    fireEvent.click(screen.getByTestId('analytics-signups-mode-all'));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ tab: 'analytics', range: '7d', signups: 'all' })
    );
    await waitFor(() =>
      expect(lastParams()).toEqual({ range: '7d', compare: 'prev', signups: 'all', accounts: 'external' })
    );

    fireEvent.click(screen.getByTestId('analytics-range-28d'));
    await waitFor(() => expect(router.state.location.search.range).toBeUndefined());
  });

  it('keeps the accounts toggle in the URL and requests that view', async () => {
    const router = await renderPage('/admin?tab=analytics&accounts=internal');
    await screen.findByText('Active users (MAU)');
    expect(lastParams()).toMatchObject({ accounts: 'internal' });
    expect(screen.getByTestId('analytics-accounts-mode-internal')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByTestId('analytics-accounts-mode-all'));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ tab: 'analytics', accounts: 'all' }));
    await waitFor(() => expect(lastParams()).toMatchObject({ accounts: 'all' }));

    fireEvent.click(screen.getByTestId('analytics-accounts-mode-external'));
    await waitFor(() => expect(router.state.location.search.accounts).toBeUndefined());
  });

  it('says in the footer which accounts are counted and tells missing rollups from missing internal counts', async () => {
    mocks.overview.mockResolvedValue({
      data: overview({ accounts: 'internal', missingDays: ['2026-06-03'], internalMissingDays: ['2026-06-01'] }),
    });
    await renderPage('/admin?tab=analytics&accounts=internal');
    expect(await screen.findByTestId('analytics-footer')).toHaveTextContent(
      'Active users count only admin, system, flagged test, staff-domain, Developer-tagged and test-persona accounts; signups, usage and top accounts always exclude them.'
    );
    expect(await screen.findByTestId('analytics-missing-rollup')).toHaveTextContent(
      'Rollup is missing for 1 day; those days show as gaps.'
    );
    expect(screen.getByTestId('analytics-missing-internal')).toHaveTextContent(
      'Internal counts are missing or incomplete for 1 day; those days show as gaps until the rollup is re-run for them.'
    );
    fireEvent.click(screen.getByTestId('analytics-missing-toggle-btn'));
    expect(screen.getByTestId('analytics-missing-days')).toHaveTextContent('2026-06-01, 2026-06-03');
  });

  it('hands the retention cohorts the Signups toggle from the URL and follows a change', async () => {
    await renderPage('/admin?tab=analytics&signups=all');
    expect(await screen.findByTestId('cohorts-stub')).toHaveAttribute('data-signups', 'all');
    fireEvent.click(screen.getByTestId('analytics-signups-mode-legit'));
    await waitFor(() => expect(screen.getByTestId('cohorts-stub')).toHaveAttribute('data-signups', 'legit'));
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
      /web app, CLI, Desktop or an agent run.*A signup is real when the email is verified.*banned or held ones included, is suspected.*External API users are shown separately regardless of Accounts and not counted/
    );
    expect(screen.getByTestId('analytics-active-users-chart')).toHaveAttribute('aria-label');
  });

  it('shows skeletons while loading', async () => {
    mocks.overview.mockReturnValue(new Promise(() => {}));
    mocks.topAccounts.mockReturnValue(new Promise(() => {}));
    await renderPage('/admin?tab=analytics');
    expect(await screen.findByTestId('analytics-active-users-skeleton')).toBeInTheDocument();
    expect(screen.getByTestId('analytics-signups-skeleton')).toBeInTheDocument();
    expect(screen.getAllByTestId('analytics-stat-skeleton')).toHaveLength(5);
  });

  it('shows an error with Try again in each section and recovers', async () => {
    mocks.overview.mockRejectedValueOnce(new Error('boom'));
    await renderPage('/admin?tab=analytics');
    const retries = await screen.findAllByTestId('admin-error-retry-btn');
    // Active users, Signups and the three usage cards; the top-account tables load separately.
    expect(retries).toHaveLength(5);
    expect(screen.getByTestId('analytics-top-users-table')).toBeInTheDocument();
    fireEvent.click(retries[0]);
    expect(await screen.findByText('Active users (MAU)')).toBeInTheDocument();
  });

  it('offers the last 90 days when the range is empty', async () => {
    const empty = overview();
    empty.activeUsers.days = empty.activeUsers.days.map(day => ({ ...day, dau: 0, wau: 0, mau: 0, apiDau: 0 }));
    empty.activeUsers.bySource = empty.activeUsers.bySource.map(day => ({ ...day, counts: {} }));
    empty.signups.totals = { legit: 0, suspected: 0 };
    empty.usage = {
      features: [],
      days: [],
      models: [],
      otherModelRequests: 0,
      totals: { requests: 0, credits: 0 },
      summaryDays: 0,
    };
    mocks.overview.mockResolvedValue({ data: empty });
    mocks.topAccounts.mockResolvedValue({ data: topAccounts({ users: [], orgs: [] }) });
    const router = await renderPage('/admin?tab=analytics');
    expect(await screen.findAllByText('No activity in this range')).toHaveLength(7);
    fireEvent.click(screen.getByTestId('analytics-active-users-show-90d-btn'));
    await waitFor(() => expect(router.state.location.search.range).toBe('90d'));
  });

  it('flags missing rollup days and a stale rollup', async () => {
    mocks.overview.mockResolvedValue({ data: overview({ missingDays: ['2026-06-01', '2026-06-02'], stale: true }) });
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

  it('drills into the clicked bar window regardless of the hovered column', async () => {
    const router = await renderPage('/admin?tab=analytics&range=7d');
    const realBar = await screen.findByTestId('analytics-signups-legit-2026-06-14-bar');
    const suspectedBar = screen.getByTestId('analytics-signups-suspected-2026-06-15-bar');
    fireEvent.mouseMove(realBar);
    fireEvent.click(suspectedBar);
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        tab: 'users',
        createdFrom: '2026-06-15T00:00:00.000Z',
        createdTo: '2026-06-16T00:00:00.000Z',
        verdict: 'suspected',
      })
    );
  });

  it.each(['legit', 'suspected'] as const)('drills into the %s bar with its verdict', async verdict => {
    const router = await renderPage('/admin?tab=analytics&range=7d');
    fireEvent.click(await screen.findByTestId(`analytics-signups-${verdict}-2026-06-14-bar`));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        tab: 'users',
        createdFrom: '2026-06-14T00:00:00.000Z',
        createdTo: '2026-06-15T00:00:00.000Z',
        verdict,
      })
    );
  });

  it('shows external API-only activity in both the users and surface views', async () => {
    const apiOnly = overview();
    apiOnly.activeUsers.days = apiOnly.activeUsers.days.map(day => ({ ...day, dau: 0, wau: 0, mau: 0 }));
    apiOnly.activeUsers.bySource = apiOnly.activeUsers.bySource.map(day => ({ ...day, counts: { api: 5 } }));
    apiOnly.activeUsers.sources = ['api'];
    mocks.get.mockResolvedValue({ data: apiOnly });
    await renderPage('/admin?tab=analytics');
    expect(await screen.findByTestId('analytics-active-users-chart')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('analytics-active-users-table-toggle-btn'));
    expect(await screen.findByTestId('analytics-active-users-table')).toHaveTextContent(
      'External API users (not counted)'
    );
    fireEvent.click(screen.getByTestId('analytics-active-users-mode-surface'));
    expect(await screen.findByTestId('analytics-surface-table')).toHaveTextContent('API (requests)');
    expect(screen.getByTestId('analytics-active-users')).not.toHaveTextContent('No activity in this range');
  });

  it('keeps weekly and monthly activity visible on days without daily use', async () => {
    const returningUsers = overview();
    returningUsers.activeUsers.days = returningUsers.activeUsers.days.map(day => ({ ...day, dau: 0, apiDau: 0 }));
    mocks.get.mockResolvedValue({ data: returningUsers });
    await renderPage('/admin?tab=analytics');
    expect(await screen.findByTestId('analytics-active-users-chart')).toBeInTheDocument();
  });

  it('labels signups Real and Suspected with no unclassified series, and shows the API line', async () => {
    await renderPage('/admin?tab=analytics');
    expect(await screen.findByTestId('analytics-signups-chart')).toBeInTheDocument();
    expect(screen.getByTestId('analytics-signups')).not.toHaveTextContent('Not classified');
    expect(screen.getByTestId('analytics-signups')).toHaveTextContent('3 real, 3 suspected');
    expect(screen.getByTestId('analytics-signups-mode-legit')).toHaveTextContent('Real only');
    fireEvent.click(screen.getByTestId('analytics-signups-table-toggle-btn'));
    expect(await screen.findByTestId('analytics-signups-table')).not.toHaveTextContent('Not classified');
    fireEvent.click(screen.getByTestId('analytics-active-users-table-toggle-btn'));
    expect(await screen.findByTestId('analytics-active-users-table')).toHaveTextContent(
      'External API users (not counted)'
    );
  });

  it('lists the signup signals as inline bars', async () => {
    await renderPage('/admin?tab=analytics');
    const signals = await screen.findByTestId('analytics-signup-signals');
    expect(within(signals).getByText('Domain burst')).toBeInTheDocument();
    expect(within(signals).getByTestId('admin-inline-bar')).toBeInTheDocument();
  });

  describe('a lone day with no neighbouring rollups', () => {
    const loneDay = () =>
      overview({
        activeUsers: {
          days: [
            {
              day: '2026-06-14',
              dau: null,
              wau: null,
              mau: null,
              apiDau: null,
              partial: false,
              previousMau: null,
              external: null,
              internal: null,
            },
            {
              day: '2026-06-15',
              dau: 1,
              wau: 1,
              mau: 1,
              apiDau: 0,
              partial: true,
              previousMau: null,
              external: { dau: 1, wau: 1, mau: 1 },
              internal: { dau: 0, wau: 0, mau: 0 },
            },
          ],
          bySource: [
            { day: '2026-06-14', partial: false, counts: null },
            { day: '2026-06-15', partial: true, counts: { web: 1, api: 1 } },
          ],
          sources: ['web', 'api'],
        },
      });

    it('draws a dot for it in the Active users view', async () => {
      mocks.overview.mockResolvedValue({ data: loneDay() });
      await renderPage('/admin?tab=analytics&range=7d');
      const chart = await screen.findByTestId('analytics-active-users-chart');
      await waitFor(() =>
        expect(chart.querySelectorAll('[data-testid="analytics-active-users-isolated-dot"]').length).toBeGreaterThan(0)
      );
    });

    it('draws sized bars for it in the By surface view', async () => {
      mocks.overview.mockResolvedValue({ data: loneDay() });
      await renderPage('/admin?tab=analytics&range=7d');
      fireEvent.click(await screen.findByTestId('analytics-active-users-mode-surface'));
      const chart = await screen.findByTestId('analytics-surface-chart');
      await waitFor(() => {
        const bars = chart.querySelectorAll('.recharts-bar-rectangle path');
        expect(bars.length).toBeGreaterThan(0);
        bars.forEach(bar => {
          const [, width, height] = /h\s*(-?[\d.]+)\s*v\s*(-?[\d.]+)/.exec(bar.getAttribute('d') ?? '') ?? [];
          expect(Math.abs(Number(width))).toBeGreaterThan(0);
          expect(Math.abs(Number(height))).toBeGreaterThan(0);
        });
      });
    });
  });

  describe('usage and top accounts', () => {
    it('shows usage by feature, model shares and credits, with the totals in the captions', async () => {
      await renderPage('/admin?tab=analytics');
      expect(await screen.findByTestId('analytics-usage-features-caption')).toHaveTextContent(
        '30 AI requests over the 27 complete UTC days; Chat leads.'
      );
      expect(screen.getByTestId('analytics-usage-models-caption')).toHaveTextContent(
        'gpt-4.1 takes 66.7% of requests. 2 requests on other models.'
      );
      expect(screen.getByTestId('analytics-credits-caption')).toHaveTextContent('300 credits consumed');

      fireEvent.click(screen.getByTestId('analytics-usage-features-table-toggle-btn'));
      const features = await screen.findByTestId('analytics-usage-features-table');
      expect(within(features).getByText('Image generation (requests)')).toBeInTheDocument();
      expect(within(features).getByText('Other (requests)')).toBeInTheDocument();
    });

    it('links the model and credit cards to their pages', async () => {
      const router = await renderPage('/admin?tab=analytics&range=7d');
      fireEvent.click(await screen.findByTestId('analytics-usage-models-open-btn'));
      await waitFor(() => expect(router.state.location.search).toMatchObject({ tab: 'model-metrics' }));
      expect(router.state.location.search.range).toBeUndefined();
      fireEvent.click(await screen.findByTestId('analytics-credits-open-btn'));
      await waitFor(() => expect(router.state.location.search).toMatchObject({ tab: 'credit-analytics' }));
    });

    it('enables Export once both requests have loaded', async () => {
      let resolveTop: (value: { data: AnalyticsTopAccounts }) => void = () => {};
      mocks.topAccounts.mockReturnValue(new Promise(resolve => (resolveTop = resolve)));
      await renderPage('/admin?tab=analytics');
      await screen.findByTestId('analytics-active-users-chart');
      expect(screen.getByTestId('analytics-export-btn')).toBeDisabled();

      resolveTop({ data: topAccounts() });
      await waitFor(() => expect(screen.getByTestId('analytics-export-btn')).not.toBeDisabled());
      fireEvent.click(screen.getByTestId('analytics-export-btn'));
      await waitFor(() => expect(mocks.download).toHaveBeenCalledWith(overview(), topAccounts()));
    });

    it('disables Export while a new range loads, so the zip never mixes two ranges', async () => {
      const router = await renderPage('/admin?tab=analytics');
      await waitFor(() => expect(screen.getByTestId('analytics-export-btn')).not.toBeDisabled());

      mocks.topAccounts.mockReturnValue(new Promise(() => {}));
      fireEvent.click(screen.getByTestId('analytics-range-7d'));
      await waitFor(() => expect(router.state.location.search.range).toBe('7d'));
      await waitFor(() => expect(mocks.topAccounts.mock.calls.at(-1)?.[1]).toEqual({ params: { range: '7d' } }));
      expect(screen.getByTestId('analytics-export-btn')).toBeDisabled();
    });

    it('says so when the export fails', async () => {
      mocks.download.mockRejectedValue(new Error('chunk failed'));
      await renderPage('/admin?tab=analytics');
      await waitFor(() => expect(screen.getByTestId('analytics-export-btn')).not.toBeDisabled());
      fireEvent.click(screen.getByTestId('analytics-export-btn'));
      await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("Couldn't export the analytics. Try again."));
      expect(screen.getByTestId('analytics-export-btn')).not.toBeDisabled();
    });

    it('disables Export while top accounts have failed, so the zip never drops their files', async () => {
      mocks.topAccounts.mockRejectedValue(new Error('boom'));
      await renderPage('/admin?tab=analytics');
      await screen.findByText('Could not load top users.');
      expect(screen.getByTestId('analytics-export-btn')).toBeDisabled();
    });

    it('requests the top accounts for the range only', async () => {
      await renderPage('/admin?tab=analytics&range=90d&signups=all');
      await screen.findByTestId('analytics-top-users-table');
      expect(mocks.topAccounts.mock.calls.at(-1)?.[1]).toEqual({ params: { range: '90d' } });
    });

    it('lists top users and orgs with plan chips and says who was left out', async () => {
      await renderPage('/admin?tab=analytics');
      const users = await screen.findByTestId('analytics-top-users');
      expect(await within(users).findByText('Ada')).toBeInTheDocument();
      expect(within(users).getByTestId('analytics-top-users-plan-aaaaaaaaaaaaaaaaaaaaaaaa')).toHaveTextContent('Paid');
      expect(within(users).getByText('60.0%')).toBeInTheDocument();
      expect(screen.getByTestId('analytics-top-users-caption')).toHaveTextContent(
        'Ranked by active days, then AI requests, over 2026-05-19 to 2026-06-14 (complete UTC days). 3 suspected and 1 suspended accounts left out.'
      );
      expect(within(screen.getByTestId('analytics-top-orgs')).getByText('Acme')).toBeInTheDocument();
      expect(screen.getByTestId('analytics-top-orgs-caption')).toHaveTextContent(
        'Org numbers add up only the usage members billed to the org.'
      );
    });

    it('says which covered days have no rollup yet, in the top tables and the usage captions', async () => {
      mocks.topAccounts.mockResolvedValue({ data: topAccounts({ missingDays: ['2026-06-14'] }) });
      const base = overview();
      mocks.overview.mockResolvedValue({ data: overview({ usage: { ...base.usage, summaryDays: 26 } }) });
      await renderPage('/admin?tab=analytics');
      expect(await screen.findByTestId('analytics-top-users-caption')).toHaveTextContent(
        '(complete UTC days). 1 day has no rollup yet and is not counted. 3 suspected'
      );
      expect(screen.getByTestId('analytics-usage-features-caption')).toHaveTextContent(
        '30 AI requests over 26 of the 27 complete UTC days (the rest have no rollup yet); Chat leads.'
      );
    });

    it('says the usage covers today alone when no complete day has a rollup yet', async () => {
      const base = overview();
      mocks.overview.mockResolvedValue({ data: overview({ usage: { ...base.usage, summaryDays: 0 } }) });
      await renderPage('/admin?tab=analytics');
      expect(await screen.findByTestId('analytics-usage-features-caption')).toHaveTextContent(
        'over today so far (no complete day has a rollup yet); Chat leads.'
      );
    });

    it('does not open a row whose account no longer exists', async () => {
      const router = await renderPage('/admin?tab=analytics');
      fireEvent.click(await screen.findByTestId('analytics-top-users-row-bbbbbbbbbbbbbbbbbbbbbbbb'));
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(router.state.location.pathname).toBe('/admin');
      expect(router.state.location.search).toMatchObject({ tab: 'analytics' });
    });

    it('opens a user profile or an org from its row', async () => {
      const root = createRootRoute();
      const admin = createRoute({
        getParentRoute: () => root,
        path: '/admin',
        validateSearch: parseAdminSearch,
        component: AnalyticsTab,
      });
      const profile = createRoute({ getParentRoute: () => root, path: '/admin/users/$userId', component: () => null });
      const router = createRouter({
        routeTree: root.addChildren([admin, profile]),
        history: createMemoryHistory({ initialEntries: ['/admin?tab=analytics'] }),
      });
      await router.load();
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={queryClient}>
          <CssVarsProvider theme={theme}>
            <RouterProvider router={router} />
          </CssVarsProvider>
        </QueryClientProvider>
      );
      fireEvent.click(await screen.findByTestId('analytics-top-orgs-row-cccccccccccccccccccccccc'));
      await waitFor(() =>
        expect(router.state.location.search).toMatchObject({ tab: 'organizations', orgId: 'cccccccccccccccccccccccc' })
      );
      fireEvent.click(await screen.findByTestId('analytics-top-users-row-aaaaaaaaaaaaaaaaaaaaaaaa'));
      await waitFor(() => expect(router.state.location.pathname).toBe('/admin/users/aaaaaaaaaaaaaaaaaaaaaaaa'));
    });
  });
});

describe('ActiveUsersTooltip', () => {
  const daysById = new Map(overview().activeUsers.days.map(day => [day.day, day]));
  const renderTooltip = (day: string) =>
    render(
      <CssVarsProvider theme={theme}>
        <ActiveUsersTooltip
          active
          label="Jun 14"
          payload={[
            { name: 'DAU', value: 20, color: 'red', payload: { day } },
            { name: 'DAU (today, partial)', value: null, payload: { day } },
          ]}
          daysById={daysById}
        />
      </CssVarsProvider>
    );

  it("shows the hovered series and the day's external and internal counts", () => {
    renderTooltip('2026-06-14');
    const tooltip = screen.getByTestId('analytics-active-users-tooltip');
    expect(tooltip).toHaveTextContent('Jun 14 (UTC)');
    expect(tooltip).toHaveTextContent('DAU: 20');
    expect(tooltip).not.toHaveTextContent('partial');
    expect(screen.getByTestId('analytics-tooltip-external')).toHaveTextContent('External: DAU 20, WAU 60, MAU 112');
    expect(screen.getByTestId('analytics-tooltip-internal')).toHaveTextContent('Internal: DAU 3, WAU 5, MAU 9');
  });

  it('says when a day has no internal counts', () => {
    daysById.set('2026-06-01', { ...overview().activeUsers.days[0], day: '2026-06-01', internal: null });
    renderTooltip('2026-06-01');
    expect(screen.getByTestId('analytics-tooltip-internal')).toHaveTextContent('Internal: not recorded');
  });
});
