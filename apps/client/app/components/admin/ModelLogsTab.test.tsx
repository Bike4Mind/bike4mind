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

    await userEvent.click(within(screen.getByTestId('model-logs-model-select')).getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: 'Claude 3 Opus' }));

    expect(fakeAdminRouter.search).toEqual({ tab: 'model-logs', modelLogsModel: 'claude-3-opus' });
  });

  it('shows an error with a retry, not the empty state, when the query fails', async () => {
    const refetch = vi.fn();
    mocks.useModelLogs.mockReturnValue(queryResult({ data: undefined, isSuccess: false, isError: true, refetch }));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs' }));
    renderTab();

    expect(screen.getByTestId('model-logs-error')).toBeTruthy();
    expect(screen.queryByTestId('model-logs-empty')).toBeNull();
    await userEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(refetch).toHaveBeenCalled();
  });

  it('shows the empty state when the query succeeds with no logs', () => {
    mocks.useModelLogs.mockReturnValue(queryResult({ data: { logs: [], total: 0 } }));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs' }));
    renderTab();

    expect(screen.getByTestId('model-logs-empty')).toBeTruthy();
    expect(screen.queryByTestId('model-logs-error')).toBeNull();
  });

  it('requests the URL page and pages by the server total', () => {
    mocks.useModelLogs.mockReturnValue(
      queryResult({
        data: {
          logs: [summary('log-1')],
          total: 60,
        },
      })
    );
    act(() => fakeAdminRouter.reset({ tab: 'model-logs', modelLogsPage: 2 }));
    renderTab();

    expect(mocks.useModelLogs).toHaveBeenCalledWith(expect.objectContaining({ page: 2, limit: 10 }));
    expect(screen.getByText('Page 2 of 6')).toBeTruthy();
    expect(screen.getByText('Total Logs: 60')).toBeTruthy();
  });

  it('stops at the final allowed page and explains how to reach additional matching logs', () => {
    mocks.useModelLogDetail.mockReturnValue({ data: undefined, isError: false });
    mocks.useModelLogs.mockReturnValue(
      queryResult({ data: { logs: [summary('log-1')], total: MODEL_LOGS_MAX_PAGE * 10 + 1 } })
    );
    act(() => fakeAdminRouter.reset({ tab: 'model-logs', modelLogsPage: MODEL_LOGS_MAX_PAGE }));
    renderTab();

    expect(mocks.useModelLogs).toHaveBeenCalledWith(expect.objectContaining({ page: MODEL_LOGS_MAX_PAGE, limit: 10 }));
    expect(screen.getByText(`Page ${MODEL_LOGS_MAX_PAGE} of ${MODEL_LOGS_MAX_PAGE}`)).toBeTruthy();
    expect(screen.getByTestId('model-logs-next-page-btn').hasAttribute('disabled')).toBe(true);
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

    expect(mocks.useModelLogDetail).toHaveBeenLastCalledWith('log-1', false);
    await userEvent.click(screen.getByTestId('model-logs-details-toggle-btn'));
    expect(mocks.useModelLogDetail).toHaveBeenLastCalledWith('log-1', true);
    expect(screen.getByTestId('model-logs-details').textContent).toContain('"gpt-4o"');

    await userEvent.click(screen.getByTestId('model-logs-details-toggle-btn'));
    expect(screen.queryByTestId('model-logs-details')).toBeNull();
    expect(mocks.useModelLogDetail).toHaveBeenLastCalledWith('log-1', false);
  });

  it('shows a progress bar while a detail loads, then an error with a retry if it fails', async () => {
    const refetch = vi.fn();
    mocks.useModelLogDetail.mockReturnValue({ data: undefined, isError: false, refetch });
    mocks.useModelLogs.mockReturnValue(queryResult({ data: { logs: [summary('log-1')], total: 1 } }));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs' }));
    const { rerender } = renderTab();

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
    mocks.useModelLogs.mockReturnValue(queryResult({ data: { logs: [summary('log-1')], total: 60 } }));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs', modelLogsPage: 2 }));
    renderTab();

    await userEvent.click(screen.getByTestId('model-logs-next-page-btn'));
    expect(fakeAdminRouter.search).toMatchObject({ modelLogsPage: 3 });
    await userEvent.click(screen.getByTestId('model-logs-prev-page-btn'));
    expect(fakeAdminRouter.search).toMatchObject({ modelLogsPage: 2 });

    await userEvent.click(screen.getByTestId('model-logs-page-size-25-radio'));
    expect(fakeAdminRouter.search).toEqual({ tab: 'model-logs', modelLogsLimit: 25 });
  });

  it('disables Previous on the first page and Next on the last', () => {
    mocks.useModelLogDetail.mockReturnValue({ data: undefined, isError: false });
    mocks.useModelLogs.mockReturnValue(queryResult({ data: { logs: [summary('log-1')], total: 1 } }));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs' }));
    renderTab();

    expect(screen.getByTestId('model-logs-prev-page-btn').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('model-logs-next-page-btn').hasAttribute('disabled')).toBe(true);
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

    await userEvent.type(screen.getByTestId('model-logs-search-input'), 'x');
    expect(fakeAdminRouter.search).toEqual({ tab: 'model-logs' });
    elapseSearchDebounce();
    await waitFor(() =>
      expect(mocks.useModelLogs).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'x', page: 1 }))
    );
  });

  it('renders a card from the summary fields alone', () => {
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
              artifacts: [{ type: 'html', preview: '<p>hi' }],
            },
          ],
          total: 1,
        },
      })
    );
    act(() => fakeAdminRouter.reset({ tab: 'model-logs' }));
    renderTab();

    expect(screen.getByText('1234ms')).toBeTruthy();
    expect(screen.getByText('10 in / 20 out')).toBeTruthy();
    expect(screen.getByText('Files: 2 | History: 4')).toBeTruthy();
    expect(screen.getByText('3 completed / 1 failed')).toBeTruthy();
    expect(screen.getByText('html: <p>hi...')).toBeTruthy();
  });

  it('shows the loading state, not the empty state, before the first page arrives', () => {
    mocks.useModelLogs.mockReturnValue(queryResult({ data: undefined, isLoading: true, isSuccess: false }));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs' }));
    renderTab();

    expect(screen.queryByTestId('model-logs-empty')).toBeNull();
    expect(screen.queryByTestId('model-logs-error')).toBeNull();
    expect(screen.getByRole('progressbar')).toBeTruthy();
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
    expect(screen.queryByTestId('model-logs-loading')).toBeNull();
    expect(screen.queryByTestId('model-logs-empty')).toBeNull();
    expect(screen.getByTestId('model-logs-refresh-btn').hasAttribute('disabled')).toBe(true);
  });

  it.each([
    ['Last 7 Days', '2026-10-15'],
    ['Last 30 Days', '2026-09-22'],
  ])('highlights %s once it sets the range', async (name, startDate) => {
    mocks.useModelLogs.mockReturnValue(queryResult({}));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs', modelLogsFrom: '2026-10-01', modelLogsTo: '2026-10-02' }));
    renderTab();

    await userEvent.click(screen.getByRole('button', { name }));

    expect(screen.getByLabelText('Start Date')).toHaveValue(startDate);
    expect(screen.getByRole('button', { name, pressed: true })).toBeTruthy();
  });

  it.each(['Start Date', 'End Date'])('updates %s when the URL changes while unfocused', label => {
    mocks.useModelLogs.mockReturnValue(queryResult({}));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs' }));
    renderTab();

    const input = screen.getByLabelText(label);
    act(() => fakeAdminRouter.reset({ tab: 'model-logs', modelLogsFrom: '2026-10-01', modelLogsTo: '2026-10-02' }));

    expect(input).toHaveValue(label === 'Start Date' ? '2026-10-01' : '2026-10-02');
  });

  it.each(['Start Date', 'End Date'])('reconciles a rejected %s draft on blur', label => {
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

      const search = screen.getByTestId('model-logs-search-input');
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
    it.each(['Start Date', 'End Date'])('keeps each year digit in %s when the URL commits late', async label => {
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
            [label === 'Start Date' ? 'modelLogsFrom' : 'modelLogsTo']: '2026-10-01',
          })
        );
        expect(input).toHaveValue('2026-10-01');
        expect(input).toHaveFocus();
      } finally {
        fakeAdminRouter.navigate.mockImplementation(commit);
      }
    });

    it.each(['Start Date', 'End Date'])('keeps each typed year digit and focus in %s', label => {
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
        [label === 'Start Date' ? 'modelLogsFrom' : 'modelLogsTo']: '2026-10-01',
      });
    });
  });
});
