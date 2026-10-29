import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ReactNode } from 'react';
import { Blob as NodeBlob } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminSubscriptionRow,
  AdminSubscriptionsListResponse,
  AdminSubscriptionsSummary,
} from '@client/app/utils/adminSubscriptionsFilter';
import { getThemeConfig } from '@client/app/utils/themes';

vi.mock('@tanstack/react-router', async () => (await import('../__tests__/fakeAdminRouter')).fakeRouterModule);

const apiGet = vi.hoisted(() => vi.fn());
const openRow = vi.hoisted(() => vi.fn());
const downloadData = vi.hoisted(() => vi.fn());
const notifications = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock('@client/app/utils/download', () => ({ downloadData }));
vi.mock('sonner', () => ({ toast: notifications }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: apiGet } }));
vi.mock('./useOpenSubscriptionRow', () => ({ useOpenSubscriptionRow: () => openRow }));

import { fakeAdminRouter } from '../__tests__/fakeAdminRouter';
import { NEWEST_PAID_SUBSCRIPTION_QUERY, useSubscriptionsLastSeen } from './subscriptionsLastSeen';
import { DEFAULT_SUBSCRIPTIONS_PARAMS } from './subscriptionsTabSearch';
import { useSubscriptionsTab } from './useSubscriptionsTabParams';
import AdminSubscriptions from './index';
import { adminSubscriptionsListQuery, adminSubscriptionsQueryKey } from './useAdminSubscriptionsList';

const theme = extendTheme({ ...getThemeConfig() });

const LIST_PATH = '/api/admin/subscriptions';
const SUMMARY_PATH = '/api/admin/subscriptions/summary';

const row = (overrides: Partial<AdminSubscriptionRow> = {}): AdminSubscriptionRow => ({
  id: 's1',
  subscriptionId: 'sub_1',
  ownerType: 'User',
  ownerId: 'u1',
  owner: {
    kind: 'User',
    id: 'u1',
    name: 'Ada Lovelace',
    username: 'ada',
    email: 'ada@example.com',
    stripeCustomerId: 'cus_1',
  },
  plan: { priceId: 'price_pro', name: 'Professional', interval: 'monthly' },
  billedInterval: { interval: 'month', intervalCount: 1 },
  status: 'active',
  source: 'stripe',
  quantity: 1,
  customCreditsPerCycle: null,
  mrr: { amount: 1900, currency: 'usd' },
  periodStartsAt: '2026-10-01T00:00:00.000Z',
  periodEndsAt: '2026-11-01T00:00:00.000Z',
  canceledAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

const compedRow = row({
  id: 's2',
  subscriptionId: 'admin_granted_u2',
  ownerId: 'u2',
  owner: {
    kind: 'User',
    id: 'u2',
    name: 'Grace Hopper',
    username: 'grace',
    email: 'grace@example.com',
    stripeCustomerId: null,
  },
  source: 'admin_grant',
  billedInterval: null,
  mrr: null,
});

const SUMMARY: AdminSubscriptionsSummary = {
  total: 3,
  views: { paying: 2, pastDue: 1, comped: 1, churned: 0 },
  mrr: { currency: 'usd', amount: 1_234_567, unpriced: 2, otherCurrency: 1 },
  pastDueMrr: { currency: 'usd', amount: 1900, unpriced: 0, otherCurrency: 0 },
  searchTruncated: false,
};

let listRows: AdminSubscriptionRow[] = [];

const listResponse = (): AdminSubscriptionsListResponse => ({
  subscriptions: listRows,
  total: listRows.length,
  page: 1,
  totalPages: listRows.length > 0 ? 1 : 0,
  searchTruncated: false,
});

const renderTab = (client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) => {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
  return render(<AdminSubscriptions />, { wrapper: Wrapper });
};

const listParams = () =>
  apiGet.mock.calls
    .filter(
      ([url, config]) => url === LIST_PATH && (config as { params: unknown }).params !== NEWEST_PAID_SUBSCRIPTION_QUERY
    )
    .map(([, config]) => (config as { params: unknown }).params);
const lastListParams = () => listParams().at(-1);

beforeEach(() => {
  apiGet.mockReset();
  openRow.mockReset();
  downloadData.mockReset();
  notifications.warning.mockReset();
  notifications.error.mockReset();
  window.localStorage.clear();
  listRows = [row(), compedRow];
  apiGet.mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => {
    if (url === SUMMARY_PATH)
      return { data: config?.params?.cancel === 'scheduled' ? { ...SUMMARY, total: 4 } : SUMMARY };
    return { data: listResponse() };
  });
  act(() => {
    useSubscriptionsTab.setState({ params: { ...DEFAULT_SUBSCRIPTIONS_PARAMS } });
    useSubscriptionsLastSeen.setState({ lastSeen: null });
    fakeAdminRouter.reset({ tab: 'subscriptions' });
  });
});

describe('AdminSubscriptions', () => {
  it('opens on the Paying view and asks the server for paying Stripe rows', async () => {
    renderTab();
    expect(await screen.findByTestId('admin-subscriptions-row-s1')).toBeTruthy();
    expect(screen.getByTestId('admin-subscriptions-views-paying-btn').getAttribute('aria-pressed')).toBe('true');
    expect(lastListParams()).toEqual({
      status: ['active', 'past_due'],
      source: 'stripe',
      page: 1,
      limit: 25,
      sortField: 'createdAt',
      sortOrder: 'desc',
    });
    expect(apiGet).toHaveBeenCalledWith(SUMMARY_PATH, { params: { status: ['active', 'past_due'], source: 'stripe' } });
    expect(apiGet).toHaveBeenCalledWith(SUMMARY_PATH, {
      params: { status: ['active', 'past_due'], source: 'stripe', cancel: 'scheduled' },
    });
  });

  it('shows a dash instead of a skeleton on the stat tiles when the summary fails', async () => {
    apiGet.mockImplementation(async (url: string) => {
      if (url === SUMMARY_PATH) throw new Error('summary down');
      return { data: listResponse() };
    });
    renderTab();
    expect(await screen.findByTestId('admin-subscriptions-row-s1')).toBeTruthy();
    await waitFor(() => expect(screen.queryAllByTestId('admin-stat-skeleton')).toHaveLength(0));
  });

  it('marks a comped row with a neutral Comped chip and shows no price', async () => {
    renderTab();
    const comped = await screen.findByTestId('admin-subscriptions-row-s2');
    expect(within(comped).getByTestId('admin-subscriptions-comped-s2').textContent).toBe('Comped');
    expect(within(comped).queryByText(/\$/)).toBeNull();
    expect(screen.queryByTestId('admin-subscriptions-comped-s1')).toBeNull();
  });

  describe('Plan', () => {
    it('labels the interval from what Stripe bills, over the catalog plan', async () => {
      listRows = [
        row({ billedInterval: { interval: 'year', intervalCount: 1 } }),
        row({ id: 's3', ownerId: 'u3', billedInterval: { interval: 'month', intervalCount: 3 } }),
        row({ id: 's4', ownerId: 'u4', billedInterval: null }),
      ];
      renderTab();
      expect((await screen.findByTestId('admin-subscriptions-interval-s1')).textContent).toBe('Yearly');
      expect(screen.getByTestId('admin-subscriptions-interval-s3').textContent).toBe('Every 3 months');
      expect(screen.getByTestId('admin-subscriptions-interval-s4').textContent).toBe('Monthly');
    });

    it('marks a price the catalog does not know as an unknown plan, with its billed interval and amount', async () => {
      listRows = [row({ plan: { priceId: 'price_legacy', name: null, interval: null } })];
      renderTab();
      const chip = await screen.findByTestId('admin-subscriptions-unknown-plan-s1');
      expect(chip.textContent).toBe('Unknown plan');
      expect(chip.closest('[title]')?.getAttribute('title')).toBe('Price ID not in the plan catalog');
      expect(screen.getByTestId('admin-subscriptions-interval-s1').textContent).toBe('Monthly');
      expect(screen.getByTestId('admin-subscriptions-mrr-s1').textContent).toBe('$19.00');
      expect(screen.queryByText('Unknown price')).toBeNull();
    });
  });

  describe('MRR', () => {
    it('shows the monthly amount under a header naming the currency', async () => {
      renderTab();
      expect((await screen.findByTestId('admin-subscriptions-mrr-s1')).textContent).toBe('$19.00');
      expect(screen.getByText('MRR (USD)')).toBeTruthy();
    });

    it('shows comps a dash, never a number, even when the row carries an amount', async () => {
      listRows = [compedRow, row({ id: 's3', ownerId: 'u3', source: 'admin_grant' })];
      renderTab();
      for (const id of ['s2', 's3']) {
        const cell = await screen.findByTestId(`admin-subscriptions-mrr-${id}`);
        expect(cell.textContent).toBe('\u2014');
        expect(within(cell).getByLabelText('None')).toBeTruthy();
      }
    });

    it('marks a paying row with no mirrored amount as not synced, and a canceled one as none', async () => {
      listRows = [
        row({ mrr: null }),
        row({ id: 's4', status: 'canceled', canceledAt: '2026-10-02T00:00:00.000Z', mrr: null }),
      ];
      renderTab();
      const unsynced = await screen.findByTestId('admin-subscriptions-mrr-s1');
      expect(unsynced.textContent).toBe('No amount');
      expect(within(unsynced).getByTitle('Stripe has no fixed amount for this price yet')).toBeTruthy();
      expect(within(unsynced).getByTestId('admin-subscriptions-mrr-unpriced-s1')).toBeTruthy();
      const canceled = screen.getByTestId('admin-subscriptions-mrr-s4');
      expect(within(canceled).getByLabelText('None')).toBeTruthy();
      expect(within(canceled).queryByText('No amount')).toBeNull();
    });

    it('shows a row billed in another currency in that currency', async () => {
      listRows = [row({ mrr: { amount: 1800, currency: 'cad' } })];
      renderTab();
      const cell = await screen.findByTestId('admin-subscriptions-mrr-s1');
      expect(cell.textContent).toBe('CA$18.00');
      expect(within(cell).getByTitle('Billed in CAD, not in the MRR total')).toBeTruthy();
    });

    it('puts the server total in the MRR tile and says what it leaves out', async () => {
      renderTab();
      const tiles = await screen.findByLabelText('Subscription totals for the current filters');
      expect(await within(tiles).findByText('$12.3K')).toBeTruthy();
      expect(within(tiles).getByText('Not in total: 2 with no billed amount, 1 in another currency')).toBeTruthy();
    });

    it('renders against a summary that predates the MRR fields', async () => {
      const legacy = { total: SUMMARY.total, views: SUMMARY.views, searchTruncated: false };
      apiGet.mockImplementation(async (url: string) => ({ data: url === SUMMARY_PATH ? legacy : listResponse() }));
      renderTab();
      const tiles = await screen.findByLabelText('Subscription totals for the current filters');
      expect(await within(tiles).findByText('Past due')).toBeTruthy();
      expect(within(tiles).queryByText(/MRR at risk/)).toBeNull();
      expect(within(tiles).queryByText(/Not in total/)).toBeNull();
    });

    it('shows the past due amount as MRR at risk', async () => {
      renderTab();
      const tiles = await screen.findByLabelText('Subscription totals for the current filters');
      expect(await within(tiles).findByText('$19.00 MRR at risk')).toBeTruthy();
    });

    it('defines MRR in a help popover', async () => {
      renderTab();
      fireEvent.click(await screen.findByTestId('admin-subscriptions-mrr-help-btn'));
      const definition = await screen.findByTestId('admin-subscriptions-mrr-definition');
      expect(definition.textContent).toContain('active or past due');
      expect(definition.textContent).toContain('Not counted: comps');
    });
  });

  it('flags Stripe rows started since the last visit as New, and never comps', async () => {
    act(() => useSubscriptionsLastSeen.setState({ lastSeen: '2026-09-01T00:00:00.000Z' }));
    renderTab();
    expect(await screen.findByTestId('admin-subscriptions-new-s1')).toBeTruthy();
    expect(screen.queryByTestId('admin-subscriptions-new-s2')).toBeNull();
  });

  it('applies built-in views through the URL and sends their filters', async () => {
    renderTab();
    await screen.findByTestId('admin-subscriptions-row-s1');

    fireEvent.click(screen.getByTestId('admin-subscriptions-views-churned-btn'));
    await waitFor(() =>
      expect(fakeAdminRouter.search).toMatchObject({ subsStatus: ['canceled'], subsCancel: 'last30', subsPage: 1 })
    );
    expect(fakeAdminRouter.search.subsSource).toBeUndefined();
    await waitFor(() =>
      expect(lastListParams()).toEqual(expect.objectContaining({ status: ['canceled'], cancel: 'last30' }))
    );
    expect(lastListParams()).not.toHaveProperty('source');

    fireEvent.click(screen.getByTestId('admin-subscriptions-views-canceling-btn'));
    await waitFor(() => expect(lastListParams()).toEqual(expect.objectContaining({ cancel: 'scheduled' })));
    expect(lastListParams()).not.toHaveProperty('status');

    fireEvent.click(screen.getByTestId('admin-subscriptions-views-comped-btn'));
    await waitFor(() => expect(lastListParams()).toEqual(expect.objectContaining({ source: 'admin_grant' })));
    expect(screen.getByTestId('admin-subscriptions-views-comped-btn').getAttribute('aria-pressed')).toBe('true');
  });

  it('does not put a cleared search back while its debounce catches up', async () => {
    renderTab();
    await screen.findByTestId('admin-subscriptions-row-s1');
    fireEvent.change(screen.getByTestId('admin-subscriptions-search-input'), { target: { value: 'ada' } });
    await waitFor(() => expect(lastListParams()).toEqual(expect.objectContaining({ search: 'ada' })));

    const before = listParams().length;
    fireEvent.click(screen.getByTestId('admin-subscriptions-views-comped-btn'));
    await act(() => new Promise(resolve => setTimeout(resolve, 500)));
    expect(listParams().slice(before)).not.toContainEqual(expect.objectContaining({ search: 'ada' }));
    expect(lastListParams()).toEqual(expect.objectContaining({ source: 'admin_grant' }));
    expect(lastListParams()).not.toHaveProperty('search');
    expect(useSubscriptionsTab.getState().params.search).toBe('');
  });

  it('reads the whole view from a shared link', async () => {
    act(() => fakeAdminRouter.reset({ tab: 'subscriptions', subsSource: 'admin_grant', subsPage: 2, subsLimit: 50 }));
    renderTab();
    await waitFor(() =>
      expect(lastListParams()).toEqual({
        source: 'admin_grant',
        page: 2,
        limit: 50,
        sortField: 'createdAt',
        sortOrder: 'desc',
      })
    );
    expect(useSubscriptionsTab.getState().params).toMatchObject({ source: 'admin_grant', status: undefined, page: 2 });
  });

  it('counts the canceling tile for the current filters, and not under another cancel filter', async () => {
    renderTab();
    const tiles = await screen.findByLabelText('Subscription totals for the current filters');
    await waitFor(() => expect(within(tiles).getByText('4')).toBeTruthy());

    fireEvent.click(screen.getByTestId('admin-subscriptions-views-churned-btn'));
    await waitFor(() => expect(within(tiles).getByText('\u2014')).toBeTruthy());
  });

  it('opens the owner when a row is activated', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('admin-subscriptions-customer-s2'));
    expect(openRow).toHaveBeenCalledWith(compedRow);
  });

  describe('empty states', () => {
    beforeEach(() => {
      listRows = [];
    });

    it('gives an empty built-in view positive copy and a way to every subscription', async () => {
      renderTab();
      expect(await screen.findByText('No paying subscriptions yet')).toBeTruthy();
      fireEvent.click(screen.getByTestId('admin-subscriptions-empty-view-all-btn'));
      await waitFor(() =>
        expect(lastListParams()).toEqual({ page: 1, limit: 25, sortField: 'createdAt', sortOrder: 'desc' })
      );
      expect(await screen.findByText('No subscriptions yet')).toBeTruthy();
      expect(screen.getByTestId('admin-subscriptions-empty-pricing-btn')).toBeTruthy();
    });

    it('names and clears both search and filters when search returns nothing', async () => {
      renderTab();
      await screen.findByText('No paying subscriptions yet');
      fireEvent.change(screen.getByTestId('admin-subscriptions-search-input'), {
        target: { value: 'missing@example.com' },
      });
      const clear = await screen.findByTestId('admin-subscriptions-empty-clear-btn');
      expect(clear).toHaveTextContent('Clear search and filters');
      fireEvent.click(clear);
      await waitFor(() =>
        expect(lastListParams()).toEqual({ page: 1, limit: 25, sortField: 'createdAt', sortOrder: 'desc' })
      );
      expect(screen.getByTestId('admin-subscriptions-search-input')).toHaveValue('');
    });

    it('offers to clear filters that match nothing', async () => {
      act(() => fakeAdminRouter.reset({ tab: 'subscriptions', subsInterval: 'yearly', subsPage: 1 }));
      renderTab();
      expect(await screen.findByText('No subscriptions match these filters')).toBeTruthy();
      fireEvent.click(screen.getByTestId('admin-subscriptions-empty-clear-btn'));
      await waitFor(() => expect(lastListParams()).not.toHaveProperty('interval'));
      expect(fakeAdminRouter.search.subsInterval).toBeUndefined();
    });
  });
});

describe('subscription summary failures', () => {
  it('reports failed totals while preserving the list and retries all summary queries', async () => {
    let failed = true;
    apiGet.mockImplementation(async (url: string) => {
      if (url === SUMMARY_PATH) {
        if (failed) throw new Error('summary unavailable');
        return { data: SUMMARY };
      }
      return { data: listResponse() };
    });
    renderTab();
    expect(await screen.findByTestId('admin-subscriptions-row-s1')).toBeTruthy();
    expect(await screen.findByTestId('admin-subscriptions-summary-error')).toBeTruthy();
    expect(screen.queryAllByTestId('admin-stat-skeleton')).toHaveLength(0);
    failed = false;
    fireEvent.click(screen.getByTestId('admin-subscriptions-summary-retry-btn'));
    await waitFor(() => expect(screen.queryByTestId('admin-subscriptions-summary-error')).toBeNull());
    expect(screen.getByText('$12.3K')).toBeTruthy();
  });

  it('hides cached money totals after their refresh fails', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(
      [...adminSubscriptionsQueryKey, 'summary', { status: ['active', 'past_due'], source: 'stripe' }],
      SUMMARY,
      { updatedAt: 0 }
    );
    apiGet.mockImplementation(async (url: string) => {
      if (url === SUMMARY_PATH) throw new Error('summary unavailable');
      return { data: listResponse() };
    });
    renderTab(client);
    await screen.findByTestId('admin-subscriptions-summary-error');
    await waitFor(() => expect(screen.queryByText('$12.3K')).toBeNull());
    expect(screen.queryByText('$19.00 MRR at risk')).toBeNull();
    expect(screen.queryByText('Not in total: 2 with no billed amount, 1 in another currency')).toBeNull();
  });

  it('reports global view-count failure even when the current filtered totals succeed', async () => {
    let failed = true;
    apiGet.mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => {
      if (url === SUMMARY_PATH) {
        if (failed && Object.keys(config?.params ?? {}).length === 0) throw new Error('counts unavailable');
        return { data: SUMMARY };
      }
      return { data: listResponse() };
    });
    renderTab();
    expect(await screen.findByText('$12.3K')).toBeTruthy();
    expect(await screen.findByTestId('admin-subscriptions-summary-error')).toBeTruthy();
    failed = false;
    fireEvent.click(screen.getByTestId('admin-subscriptions-summary-retry-btn'));
    await waitFor(() => expect(screen.queryByTestId('admin-subscriptions-summary-error')).toBeNull());
  });

  it('does not acknowledge unread subscriptions when the list fails', async () => {
    act(() => useSubscriptionsLastSeen.setState({ lastSeen: '2026-09-01T00:00:00.000Z' }));
    apiGet.mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => {
      if (url === SUMMARY_PATH) return { data: SUMMARY };
      if (config?.params?.status) throw new Error('list unavailable');
      return { data: listResponse() };
    });
    renderTab();
    expect(await screen.findByText('Could not load subscriptions.')).toBeTruthy();
    expect(useSubscriptionsLastSeen.getState().lastSeen).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('subscription CSV export', () => {
  it('downloads the filtered export and warns about both server truncation markers', async () => {
    const blob = new NodeBlob(['id\nsub_1\n# Truncated at 10000 rows\n# Search matched more than 500 accounts\n']);
    apiGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/export'))
        return { data: blob, headers: { 'content-disposition': 'attachment; filename="filtered.csv"' } };
      return { data: url === SUMMARY_PATH ? SUMMARY : listResponse() };
    });
    renderTab();
    await screen.findByTestId('admin-subscriptions-row-s1');
    fireEvent.click(screen.getByTestId('admin-subscriptions-export-btn'));
    await waitFor(() => expect(downloadData).toHaveBeenCalledWith(blob, 'filtered.csv', 'text/csv;charset=utf-8;'));
    expect(apiGet).toHaveBeenCalledWith(`${LIST_PATH}/export`, {
      params: { status: ['active', 'past_due'], source: 'stripe' },
      responseType: 'blob',
    });
    expect(notifications.warning).toHaveBeenCalledTimes(2);
  });

  it('reports an export failure and leaves the button available for retry', async () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    apiGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/export')) throw new Error('export unavailable');
      return { data: url === SUMMARY_PATH ? SUMMARY : listResponse() };
    });
    renderTab();
    await screen.findByTestId('admin-subscriptions-row-s1');
    const button = screen.getByTestId('admin-subscriptions-export-btn');
    fireEvent.click(button);
    await waitFor(() => expect(notifications.error).toHaveBeenCalledWith('Failed to download the subscriptions CSV.'));
    expect(button).not.toBeDisabled();
    expect(downloadData).not.toHaveBeenCalled();
    diagnostic.mockRestore();
  });
});

it('does not acknowledge newer rows from a cached list when this visit refresh fails', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const previous = '2026-09-01T00:00:00.000Z';
  act(() => useSubscriptionsLastSeen.setState({ lastSeen: previous }));
  client.setQueryData(
    [...adminSubscriptionsQueryKey, 'list', adminSubscriptionsListQuery(DEFAULT_SUBSCRIPTIONS_PARAMS)],
    listResponse()
  );
  apiGet.mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => {
    if (url === SUMMARY_PATH) return { data: SUMMARY };
    if (config?.params?.status) throw new Error('mount refresh unavailable');
    return { data: listResponse() };
  });
  renderTab(client);
  expect(await screen.findByText('Could not load subscriptions.')).toBeTruthy();
  expect(useSubscriptionsLastSeen.getState().lastSeen).toBe(previous);
});
