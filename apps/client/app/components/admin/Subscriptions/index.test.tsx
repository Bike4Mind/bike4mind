import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ReactNode } from 'react';
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
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: apiGet } }));
vi.mock('./useOpenSubscriptionRow', () => ({ useOpenSubscriptionRow: () => openRow }));

import { fakeAdminRouter } from '../__tests__/fakeAdminRouter';
import { useSubscriptionsLastSeen } from './subscriptionsLastSeen';
import { DEFAULT_SUBSCRIPTIONS_PARAMS } from './subscriptionsTabSearch';
import { useSubscriptionsTab } from './useSubscriptionsTabParams';
import AdminSubscriptions from './index';

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
  plan: { priceId: 'price_pro', name: 'Pro', interval: 'monthly' },
  status: 'active',
  source: 'stripe',
  quantity: 1,
  customCreditsPerCycle: null,
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
});

const SUMMARY: AdminSubscriptionsSummary = {
  total: 3,
  views: { paying: 2, pastDue: 1, comped: 1, churned: 0 },
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

const renderTab = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
  return render(<AdminSubscriptions />, { wrapper: Wrapper });
};

const listParams = () =>
  apiGet.mock.calls.filter(([url]) => url === LIST_PATH).map(([, config]) => (config as { params: unknown }).params);
const lastListParams = () => listParams().at(-1);

beforeEach(() => {
  apiGet.mockReset();
  openRow.mockReset();
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

  it('marks a comped row with a neutral Comped chip and shows no price', async () => {
    renderTab();
    const comped = await screen.findByTestId('admin-subscriptions-row-s2');
    expect(within(comped).getByTestId('admin-subscriptions-comped-s2').textContent).toBe('Comped');
    expect(within(comped).queryByText(/\$/)).toBeNull();
    expect(screen.queryByTestId('admin-subscriptions-comped-s1')).toBeNull();
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
    const tiles = await screen.findByLabelText('Subscription counts for the current filters');
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
