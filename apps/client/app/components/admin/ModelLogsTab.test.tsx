import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
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

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ModelLogsTab />
    </CssVarsProvider>
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

describe('ModelLogsTab', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T12:00:00'));
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
      <CssVarsProvider theme={appTheme}>
        <ModelLogsTab />
      </CssVarsProvider>
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
    expect(mocks.useModelLogs).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'x', page: 1 }));
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

  it('refetches on Refresh', async () => {
    const refetch = vi.fn();
    mocks.useModelLogs.mockReturnValue(queryResult({ data: { logs: [], total: 0 }, refetch }));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs' }));
    renderTab();

    await userEvent.click(screen.getByTestId('model-logs-refresh-btn'));
    expect(refetch).toHaveBeenCalled();
  });
});
