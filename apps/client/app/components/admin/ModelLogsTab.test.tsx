import React from 'react';
import { MODEL_LOGS_MAX_PAGE } from '@client/shared/modelLogs';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  useModelLogs: vi.fn(),
  useModelLogDetail: vi.fn(),
}));

vi.mock('@tanstack/react-router', async () => (await import('./__tests__/fakeAdminRouter')).fakeRouterModule);
vi.mock('@client/app/hooks/useModelLogs', () => ({
  useModelLogs: mocks.useModelLogs,
  useModelLogDetail: mocks.useModelLogDetail,
}));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));

import { fakeAdminRouter } from './__tests__/fakeAdminRouter';
import { ModelLogsTab } from './ModelLogsTab';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <ModelLogsTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );

const summary = (id: string) => ({
  id,
  timestamp: '2026-10-20T12:00:00Z',
  modelName: 'gpt-4o',
  attachedFileCount: 0,
  completedStepCount: 0,
  failedStepCount: 0,
  artifacts: [],
});

const queryResult = (overrides: Record<string, unknown>) => ({
  data: { logs: [] },
  isLoading: false,
  isSuccess: true,
  refetch: vi.fn(),
  ...overrides,
});

// The search debounce times itself with Date.now(), which these tests freeze.
const elapseSearchDebounce = () => vi.setSystemTime(Date.now() + 1000);

const SUPPORT_CASE = 'ZD-4821';

// Searching and expanding a log are support reads: both stay disabled until a case is entered.
const enterSupportCase = async (value = SUPPORT_CASE) => {
  await userEvent.type(screen.getByTestId('model-logs-support-case-input'), `${value}{Enter}`);
};

// A row opens its detail drawer, which holds the prompt-details toggle.
const openLog = async (id = 'log-1') => {
  await userEvent.click(screen.getByTestId(`model-logs-row-${id}`));
  return within(screen.getByTestId('model-logs-drawer'));
};

describe('ModelLogsTab', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T12:00:00'));
    queryClient.clear();
    mocks.useModelLogs.mockReset();
    mocks.useModelLogDetail.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clamps a linked page past the end once the results have loaded', async () => {
    mocks.useModelLogs.mockReturnValue(queryResult({}));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs', modelLogsPage: 3 }));
    renderTab();

    await waitFor(() => expect(fakeAdminRouter.search).toEqual({ tab: 'model-logs' }));
    expect(fakeAdminRouter.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ replace: true }));
  });

  it('leaves a linked page alone until the results have loaded', () => {
    mocks.useModelLogs.mockReturnValue(queryResult({ data: undefined, isSuccess: false }));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs', modelLogsPage: 3 }));
    renderTab();

    expect(fakeAdminRouter.navigate).not.toHaveBeenCalled();
  });

  it('goes back to the first page when the model filter changes', async () => {
    mocks.useModelLogs.mockReturnValue(queryResult({ data: undefined, isSuccess: false }));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs', modelLogsPage: 3 }));
    renderTab();

    await userEvent.click(screen.getByTestId('admin-filter-model-logs-model'));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Claude 3 Opus' }));

    expect(fakeAdminRouter.search).toEqual({ tab: 'model-logs', modelLogsModel: 'claude-3-opus' });
  });

  it('shows an error with a retry, not the empty state, when the query fails', async () => {
    const refetch = vi.fn();
    mocks.useModelLogs.mockReturnValue(queryResult({ data: undefined, isSuccess: false, isError: true, refetch }));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs' }));
    renderTab();

    expect(screen.getByTestId('admin-error-state')).toHaveTextContent('Could not load model logs.');
    expect(screen.queryByTestId('model-logs-empty')).toBeNull();
    await userEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(refetch).toHaveBeenCalled();
  });

  it('shows the empty state when the query succeeds with no logs', () => {
    mocks.useModelLogs.mockReturnValue(queryResult({ data: { logs: [], total: 0 } }));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs' }));
    renderTab();

    expect(screen.getByTestId('model-logs-empty')).toBeTruthy();
    expect(screen.queryByTestId('admin-error-state')).toBeNull();
  });

  it('offers the last 30 days from the empty state, and a refresh once that is the range', async () => {
    const refetch = vi.fn();
    mocks.useModelLogs.mockReturnValue(queryResult({ data: { logs: [], total: 0 }, refetch }));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs', modelLogsPage: 2 }));
    renderTab();

    await userEvent.click(screen.getByTestId('model-logs-empty-30-days-btn'));
    expect(fakeAdminRouter.search).toEqual({
      tab: 'model-logs',
      modelLogsFrom: '2026-09-22',
      modelLogsTo: '2026-10-21',
    });

    await userEvent.click(screen.getByTestId('model-logs-empty-refresh-btn'));
    expect(refetch).toHaveBeenCalled();
  });

  it('requests the URL page and pages by the server total', () => {
    mocks.useModelLogs.mockReturnValue(
      queryResult({
        data: {
          logs: Array.from({ length: 25 }, (_, index) => summary(`log-${index + 1}`)),
          total: 60,
        },
      })
    );
    act(() => fakeAdminRouter.reset({ tab: 'model-logs', modelLogsPage: 2 }));
    renderTab();

    expect(mocks.useModelLogs).toHaveBeenCalledWith(expect.objectContaining({ page: 2, limit: 25 }));
    expect(screen.getByTestId('admin-table-range')).toHaveTextContent('26 to 50 of 60');
    expect(screen.getByRole('heading', { level: 1, name: /Model logs/ })).toHaveTextContent('(60)');
  });

  it('stops at the final allowed page and explains how to reach additional matching logs', () => {
    mocks.useModelLogDetail.mockReturnValue({ data: undefined, isError: false });
    mocks.useModelLogs.mockReturnValue(
      queryResult({ data: { logs: [summary('log-1')], total: MODEL_LOGS_MAX_PAGE * 25 + 1 } })
    );
    act(() => fakeAdminRouter.reset({ tab: 'model-logs', modelLogsPage: MODEL_LOGS_MAX_PAGE }));
    renderTab();

    expect(mocks.useModelLogs).toHaveBeenCalledWith(expect.objectContaining({ page: MODEL_LOGS_MAX_PAGE, limit: 25 }));
    expect(screen.getByTestId('admin-table-next-btn')).toBeDisabled();
    expect(screen.getByTestId('model-logs-page-limit').textContent).toContain(
      'Narrow the filters to see additional logs.'
    );
    expect(fakeAdminRouter.navigate).not.toHaveBeenCalled();
  });

  it('fetches a log detail only once it is expanded', async () => {
    mocks.useModelLogDetail.mockReturnValue({ data: { id: 'log-1', model: { name: 'gpt-4o' } }, isError: false });
    mocks.useModelLogs.mockReturnValue(
      queryResult({
        data: {
          logs: [summary('log-1')],
          total: 1,
        },
      })
    );
    act(() => fakeAdminRouter.reset({ tab: 'model-logs' }));
    renderTab();

    await enterSupportCase();
    const drawer = await openLog();
    await waitFor(() => expect(drawer.getByTestId('model-logs-details-toggle-btn')).toBeEnabled());
    expect(mocks.useModelLogDetail).toHaveBeenLastCalledWith('log-1', SUPPORT_CASE, false);
    await userEvent.click(drawer.getByTestId('model-logs-details-toggle-btn'));
    expect(mocks.useModelLogDetail).toHaveBeenLastCalledWith('log-1', SUPPORT_CASE, true);
    expect(drawer.getByTestId('model-logs-details').textContent).toContain('"gpt-4o"');

    await userEvent.click(drawer.getByTestId('model-logs-details-toggle-btn'));
    expect(screen.queryByTestId('model-logs-details')).toBeNull();
    expect(mocks.useModelLogDetail).toHaveBeenLastCalledWith('log-1', SUPPORT_CASE, false);
  });

  it('keeps the search input and the details toggle disabled until a valid support case is typed', async () => {
    mocks.useModelLogs.mockReturnValue(queryResult({ data: { logs: [summary('log-1')], total: 1 } }));
    mocks.useModelLogDetail.mockReturnValue({ data: undefined, isError: false });
    act(() => fakeAdminRouter.reset({ tab: 'model-logs' }));
    renderTab();

    expect(screen.getByTestId('model-logs-search-input')).toBeDisabled();
    await openLog();
    expect(screen.getByTestId('model-logs-details-toggle-btn')).toBeDisabled();
    await userEvent.click(screen.getByTestId('model-logs-drawer-close-btn'));

    await enterSupportCase('ab');
    await waitFor(() => expect(screen.getByTestId('model-logs-search-input')).toBeDisabled());

    // Typed but not committed: a half-typed case must never reach the server.
    await userEvent.type(screen.getByTestId('model-logs-support-case-input'), 'c');
    elapseSearchDebounce();
    expect(screen.getByTestId('model-logs-search-input')).toBeDisabled();

    await userEvent.type(screen.getByTestId('model-logs-support-case-input'), '{Enter}');
    await waitFor(() => expect(screen.getByTestId('model-logs-search-input')).toBeEnabled());
    await openLog();
    expect(screen.getByTestId('model-logs-details-toggle-btn')).toBeEnabled();
  });

  it('sends the support case to the list only together with a search', async () => {
    mocks.useModelLogs.mockReturnValue(queryResult({ data: { logs: [], total: 0 } }));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs' }));
    renderTab();

    await enterSupportCase();
    await waitFor(() =>
      expect(mocks.useModelLogs).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: undefined, supportCase: SUPPORT_CASE })
      )
    );
    await userEvent.type(screen.getByTestId('model-logs-search-input'), 'x');
    elapseSearchDebounce();
    await waitFor(() =>
      expect(mocks.useModelLogs).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: 'x', supportCase: SUPPORT_CASE })
      )
    );
  });

  it('shows a progress bar while a detail loads, then an error with a retry if it fails', async () => {
    const refetch = vi.fn();
    mocks.useModelLogDetail.mockReturnValue({ data: undefined, isError: false, refetch });
    mocks.useModelLogs.mockReturnValue(queryResult({ data: { logs: [summary('log-1')], total: 1 } }));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs' }));
    const { rerender } = renderTab();

    await enterSupportCase();
    await openLog();
    await waitFor(() => expect(screen.getByTestId('model-logs-details-toggle-btn')).toBeEnabled());
    await userEvent.click(screen.getByTestId('model-logs-details-toggle-btn'));
    expect(screen.getByTestId('model-logs-details-loading')).toBeTruthy();

    mocks.useModelLogDetail.mockReturnValue({ data: undefined, isError: true, refetch });
    rerender(
      <QueryClientProvider client={queryClient}>
        <CssVarsProvider theme={appTheme}>
          <ModelLogsTab />
        </CssVarsProvider>
      </QueryClientProvider>
    );
    expect(screen.queryByTestId('model-logs-details-loading')).toBeNull();
    await userEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(refetch).toHaveBeenCalled();
  });

  it('moves between pages and resets to the first page on a page-size change', async () => {
    mocks.useModelLogDetail.mockReturnValue({ data: undefined, isError: false });
    mocks.useModelLogs.mockReturnValue(queryResult({ data: { logs: [summary('log-1')], total: 120 } }));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs', modelLogsPage: 2 }));
    renderTab();

    await userEvent.click(screen.getByTestId('admin-table-next-btn'));
    expect(fakeAdminRouter.search).toMatchObject({ modelLogsPage: 3 });
    await userEvent.click(screen.getByTestId('admin-table-previous-btn'));
    expect(fakeAdminRouter.search).toMatchObject({ modelLogsPage: 2 });

    await userEvent.click(within(screen.getByTestId('admin-table-page-size')).getByRole('combobox'));
    await userEvent.click(await screen.findByTestId('admin-table-page-size-50'));
    expect(fakeAdminRouter.search).toEqual({ tab: 'model-logs', modelLogsLimit: 50 });
  });

  it('disables Previous on the first page and Next on the last', () => {
    mocks.useModelLogDetail.mockReturnValue({ data: undefined, isError: false });
    mocks.useModelLogs.mockReturnValue(queryResult({ data: { logs: [summary('log-1')], total: 1 } }));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs' }));
    renderTab();

    expect(screen.getByTestId('admin-table-previous-btn')).toBeDisabled();
    expect(screen.getByTestId('admin-table-next-btn')).toBeDisabled();
  });

  it('does not clamp the page against a placeholder from the previous filter', () => {
    mocks.useModelLogs.mockReturnValue(queryResult({ data: { logs: [], total: 0 }, isPlaceholderData: true }));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs', modelLogsPage: 3 }));
    renderTab();

    expect(fakeAdminRouter.navigate).not.toHaveBeenCalled();
  });

  it('resets to the first page when the search text changes', async () => {
    mocks.useModelLogs.mockReturnValue(queryResult({ data: { logs: [], total: 0 }, isPlaceholderData: true }));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs', modelLogsPage: 3 }));
    renderTab();

    await enterSupportCase();
    await waitFor(() => expect(screen.getByTestId('model-logs-search-input')).toBeEnabled());
    await userEvent.type(screen.getByTestId('model-logs-search-input'), 'x');
    expect(fakeAdminRouter.search).toEqual({ tab: 'model-logs' });
    elapseSearchDebounce();
    await waitFor(() =>
      expect(mocks.useModelLogs).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'x', page: 1 }))
    );
  });

  it('renders a row from the summary fields alone, and the full summary in its drawer', async () => {
    mocks.useModelLogDetail.mockReturnValue({ data: undefined, isError: false });
    mocks.useModelLogs.mockReturnValue(
      queryResult({
        data: {
          logs: [
            {
              ...summary('log-1'),
              totalResponseTime: 1234,
              inputTokens: 10,
              outputTokens: 20,
              attachedFileCount: 2,
              messageHistoryLength: 4,
              completedStepCount: 3,
              failedStepCount: 1,
              artifacts: [{ type: 'html' }],
            },
          ],
          total: 1,
        },
      })
    );
    act(() => fakeAdminRouter.reset({ tab: 'model-logs' }));
    renderTab();

    const row = within(screen.getByTestId('model-logs-row-log-1'));
    expect(row.getByText('1,234 ms')).toBeTruthy();
    expect(row.getByText('10 / 20')).toBeTruthy();
    expect(row.getByText('2 / 4')).toBeTruthy();
    expect(screen.getByTestId('model-logs-row-log-1')).toHaveTextContent('3 completed, 1 failed');

    const drawer = await openLog();
    expect(drawer.getByTestId('model-logs-drawer-summary')).toHaveTextContent('Steps failed1');
    expect(drawer.getByText('html')).toBeTruthy();
    expect(mocks.useModelLogDetail).toHaveBeenLastCalledWith('log-1', '', false);
  });

  it('shows the loading state, not the empty state, before the first page arrives', () => {
    mocks.useModelLogs.mockReturnValue(queryResult({ data: undefined, isLoading: true, isSuccess: false }));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs' }));
    renderTab();

    expect(screen.queryByTestId('model-logs-empty')).toBeNull();
    expect(screen.queryByTestId('admin-error-state')).toBeNull();
    expect(screen.getAllByTestId('admin-table-skeleton-row').length).toBeGreaterThan(0);
  });

  it('refreshes active details and marks collapsed details stale', async () => {
    const fetchActiveDetail = vi.fn().mockResolvedValue({ id: 'active' });
    const fetchCollapsedDetail = vi.fn().mockResolvedValue({ id: 'collapsed' });
    const DetailQueries = () => {
      useQuery({ queryKey: ['modelLogDetail', 'active'], queryFn: fetchActiveDetail, staleTime: Infinity });
      useQuery({
        queryKey: ['modelLogDetail', 'collapsed'],
        queryFn: fetchCollapsedDetail,
        enabled: false,
        staleTime: Infinity,
      });
      return null;
    };
    queryClient.setQueryData(['modelLogDetail', 'collapsed'], { id: 'collapsed' });
    mocks.useModelLogs.mockReturnValue(queryResult({ data: { logs: [], total: 0 } }));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs' }));
    render(
      <QueryClientProvider client={queryClient}>
        <CssVarsProvider theme={appTheme}>
          <DetailQueries />
          <ModelLogsTab />
        </CssVarsProvider>
      </QueryClientProvider>
    );
    await waitFor(() => expect(fetchActiveDetail).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByTestId('model-logs-refresh-btn'));

    await waitFor(() => expect(fetchActiveDetail).toHaveBeenCalledTimes(2));
    expect(fetchCollapsedDetail).not.toHaveBeenCalled();
    expect(queryClient.getQueryState(['modelLogDetail', 'collapsed'])?.isInvalidated).toBe(true);
  });

  it('refetches on Refresh', async () => {
    const refetch = vi.fn();
    mocks.useModelLogs.mockReturnValue(queryResult({ data: { logs: [], total: 0 }, refetch }));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs' }));
    renderTab();

    await userEvent.click(screen.getByTestId('model-logs-refresh-btn'));
    expect(refetch).toHaveBeenCalled();
  });

  it('shows a progress bar over the old rows and disables Refresh while refetching', () => {
    mocks.useModelLogDetail.mockReturnValue({ data: undefined, isError: false });
    mocks.useModelLogs.mockReturnValue(queryResult({ data: { logs: [summary('log-1')], total: 1 }, isFetching: true }));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs' }));
    renderTab();

    expect(screen.getByTestId('model-logs-refetching')).toBeTruthy();
    expect(screen.queryByTestId('admin-table-skeleton-row')).toBeNull();
    expect(screen.getByTestId('model-logs-row-log-1')).toBeTruthy();
    expect(screen.getByTestId('model-logs-refresh-btn').hasAttribute('disabled')).toBe(true);
  });

  it.each([
    ['7 days', '2026-10-15'],
    ['30 days', '2026-09-22'],
  ])('highlights %s once it sets the range', async (name, startDate) => {
    mocks.useModelLogs.mockReturnValue(queryResult({}));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs', modelLogsFrom: '2026-10-01', modelLogsTo: '2026-10-02' }));
    renderTab();

    await userEvent.click(screen.getByRole('button', { name }));

    expect(screen.getByLabelText('Start date')).toHaveValue(startDate);
    expect(screen.getByRole('button', { name, pressed: true })).toBeTruthy();
  });

  it.each(['Start date', 'End date'])('updates %s when the URL changes while unfocused', label => {
    mocks.useModelLogs.mockReturnValue(queryResult({}));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs' }));
    renderTab();

    const input = screen.getByLabelText(label);
    act(() => fakeAdminRouter.reset({ tab: 'model-logs', modelLogsFrom: '2026-10-01', modelLogsTo: '2026-10-02' }));

    expect(input).toHaveValue(label === 'Start date' ? '2026-10-01' : '2026-10-02');
  });

  it.each(['Start date', 'End date'])('reconciles a rejected %s draft on blur', label => {
    mocks.useModelLogs.mockReturnValue(queryResult({}));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs' }));
    renderTab();

    const input = screen.getByLabelText(label);
    const originalDate = (input as HTMLInputElement).value;
    act(() => input.focus());
    // Clearing a date is normalized back to the default by the URL parser.
    fireEvent.change(input, { target: { value: '' } });
    expect(input).toHaveValue('');

    act(() => input.blur());
    expect(input).toHaveValue(originalDate);
  });

  describe('while a filter change refetches', () => {
    // useModelLogs keeps previous data once a load has succeeded, so the filters only lose their
    // data after a failed first load: errored for the first query key, loading for any other.
    const failOnlyFirstKey = () => {
      let firstKey: string | undefined;
      mocks.useModelLogs.mockImplementation((options: unknown) => {
        const key = JSON.stringify(options);
        firstKey ??= key;
        return key === firstKey
          ? queryResult({ data: undefined, isError: true, isSuccess: false })
          : queryResult({ data: undefined, isLoading: true, isSuccess: false });
      });
    };

    it('keeps each typed character and focus in the search box', async () => {
      failOnlyFirstKey();
      act(() => fakeAdminRouter.reset({ tab: 'model-logs' }));
      renderTab();

      await enterSupportCase();
      const search = screen.getByTestId('model-logs-search-input');
      await waitFor(() => expect(search).toBeEnabled());
      await userEvent.type(search, 'sonnet');
      elapseSearchDebounce();
      await waitFor(() =>
        expect(mocks.useModelLogs).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'sonnet' }))
      );

      expect(search).toHaveValue('sonnet');
      expect(search).toHaveFocus();
    });

    // The real router commits a navigate after React re-renders, so the old date comes back in
    // first; writing it into the input resets the browser's year-typing buffer.
    it.each(['Start date', 'End date'])('keeps each year digit in %s when the URL commits late', async label => {
      failOnlyFirstKey();
      act(() => fakeAdminRouter.reset({ tab: 'model-logs' }));
      const commit = fakeAdminRouter.navigate.getMockImplementation()!;
      fakeAdminRouter.navigate.mockImplementation(options => {
        setTimeout(() => commit(options));
      });
      try {
        renderTab();

        const input = screen.getByLabelText(label);
        act(() => input.focus());
        for (const value of ['0002-10-01', '0020-10-01', '0202-10-01', '2026-10-01']) {
          fireEvent.change(input, { target: { value } });
          expect(input).toHaveValue(value);
        }

        await waitFor(() =>
          expect(fakeAdminRouter.search).toMatchObject({
            [label === 'Start date' ? 'modelLogsFrom' : 'modelLogsTo']: '2026-10-01',
          })
        );
        expect(input).toHaveValue('2026-10-01');
        expect(input).toHaveFocus();
      } finally {
        fakeAdminRouter.navigate.mockImplementation(commit);
      }
    });

    it.each(['Start date', 'End date'])('keeps each typed year digit and focus in %s', label => {
      failOnlyFirstKey();
      act(() => fakeAdminRouter.reset({ tab: 'model-logs' }));
      renderTab();

      const input = screen.getByLabelText(label);
      act(() => input.focus());
      // A browser date input commits the year segment once per digit.
      for (const value of ['0002-10-01', '0020-10-01', '0202-10-01', '2026-10-01']) {
        fireEvent.change(input, { target: { value } });
        expect(input).toBeInTheDocument();
        expect(input).toHaveFocus();
      }

      expect(input).toHaveValue('2026-10-01');
      expect(fakeAdminRouter.search).toMatchObject({
        [label === 'Start date' ? 'modelLogsFrom' : 'modelLogsTo']: '2026-10-01',
      });
    });
  });
});
