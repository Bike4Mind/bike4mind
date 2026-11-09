import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

// Shared mock handles (hoisted so the vi.mock factories can close over them).
const { recacheModel, recacheSpend, useSpendSpy, useModelMetricsSpy, updateUrlState, urlState } = vi.hoisted(() => ({
  recacheModel: vi.fn(),
  recacheSpend: vi.fn(),
  useSpendSpy: vi.fn(),
  useModelMetricsSpy: vi.fn(),
  updateUrlState: vi.fn(),
  urlState: { query: '', view: '', filters: { period: '', model: '', status: '' } },
}));

const { metricsState } = vi.hoisted(() => ({
  metricsState: {
    data: [{ id: 'm1' }] as unknown[],
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
    isError: false,
    refetch: vi.fn(),
  },
}));
vi.mock('./hooks/useModelMetrics', () => ({
  useModelMetrics: (...args: unknown[]) => {
    useModelMetricsSpy(...args);
    return { ...metricsState, recache: recacheModel };
  },
}));
vi.mock('@client/app/components/admin/shared/useAdminListUrlState', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/components/admin/shared/useAdminListUrlState')>()),
  // Same reference per render, like the real hook's memoised state.
  useAdminListUrlState: () => [urlState, updateUrlState],
}));
vi.mock('./hooks/useSpend', () => ({
  useSpend: (...args: unknown[]) => {
    useSpendSpy(...args);
    return { data: undefined, isLoading: false, isError: false, recache: recacheSpend };
  },
}));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({ useModelInfo: () => ({ data: [] }) }));
vi.mock('./utils/chartDataProcessor', () => ({ processChartData: () => [] }));
vi.mock('./utils/csvExport', () => ({ exportToCSV: vi.fn() }));

vi.mock('./components/ControlPanel', () => ({
  ControlPanel: ({ onUserChange, userFilter }: { onUserChange: (user: string) => void; userFilter: string }) => (
    <div data-testid="toolbar" data-user={userFilter}>
      <button data-testid="stub-pick-user" onClick={() => onUserChange('user-1')} />
    </div>
  ),
}));
vi.mock('./components/OverviewTab', () => ({ OverviewTab: () => <div data-testid="overview" /> }));
vi.mock('./components/AnalyticsTab', () => ({ AnalyticsTab: () => <div data-testid="analytics" /> }));
vi.mock('./components/RawDataTab', () => ({ RawDataTab: () => <div data-testid="rawdata" /> }));
vi.mock('./components/SpendTab', () => ({ SpendTab: () => <div data-testid="spend" /> }));
vi.mock('./components/MetricsInfoModal', () => ({ MetricsInfoModal: () => null }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));

import ModelMetricsTab from './index';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const resetState = () => {
  Object.assign(metricsState, {
    data: [{ id: 'm1' }],
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
    isError: false,
  });
  urlState.filters = { period: '', model: '', status: '' };
};

const lastMetricsFilters = () => useModelMetricsSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
const lastUseSpendCall = () => useSpendSpy.mock.calls.at(-1) as [unknown, { enabled: boolean }];

describe('ModelMetricsTab - Spend wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it('keeps the spend query gated off until the Spend tab is active', () => {
    render(<ModelMetricsTab />, { wrapper: TestWrapper });
    // Default tab is overview, so the spend query starts disabled.
    expect(lastUseSpendCall()[1]).toEqual({ enabled: false });
  });

  it('enables the spend query once the Spend tab is selected', () => {
    render(<ModelMetricsTab />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByRole('tab', { name: /Spend/ }));
    expect(lastUseSpendCall()[1]).toEqual({ enabled: true });
  });

  it('passes only the spend-relevant filters to useSpend', () => {
    urlState.filters = { period: '24h', model: 'model-a', status: 'error' };
    render(<ModelMetricsTab />, { wrapper: TestWrapper });
    const spendFilters = lastUseSpendCall()[0] as Record<string, unknown>;
    expect(spendFilters).toStrictEqual({
      dateFrom: expect.any(String),
      dateTo: expect.any(String),
      userFilter: undefined,
      modelFilter: 'model-a',
    });
    expect(spendFilters).not.toHaveProperty('statusFilter');
  });

  it('Refresh busts the model-metrics cache on a non-spend tab', () => {
    render(<ModelMetricsTab />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('model-metrics-refresh-btn'));
    expect(recacheModel).toHaveBeenCalledTimes(1);
    expect(recacheSpend).not.toHaveBeenCalled();
  });

  it('Refresh busts the spend cache when the Spend tab is active', () => {
    render(<ModelMetricsTab />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByRole('tab', { name: /Spend/ }));
    fireEvent.click(screen.getByTestId('model-metrics-refresh-btn'));
    expect(recacheSpend).toHaveBeenCalledTimes(1);
    expect(recacheModel).not.toHaveBeenCalled();
  });
});

describe('ModelMetricsTab - page frame', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it('renders the page header and plain tab labels', () => {
    render(<ModelMetricsTab />, { wrapper: TestWrapper });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Model metrics');
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
      'Overview',
      'Analytics',
      'Raw data',
      'Spend',
    ]);
  });

  it('keeps every tab, including Spend, when there are no rows and shows the empty state in Overview', () => {
    metricsState.data = [];
    render(<ModelMetricsTab />, { wrapper: TestWrapper });
    expect(screen.getByTestId('admin-empty-state')).toHaveTextContent('No model calls yet');
    expect(screen.getByRole('tab', { name: 'Spend' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Analytics' })).toBeInTheDocument();
    expect(screen.getByTestId('toolbar')).toBeInTheDocument();
  });

  it('offers Refresh from the unfiltered empty state', () => {
    metricsState.data = [];
    render(<ModelMetricsTab />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('model-metrics-empty-refresh-btn'));
    expect(recacheModel).toHaveBeenCalledTimes(1);
  });

  it('keeps every tab and offers a retry when the query fails', () => {
    metricsState.data = [];
    metricsState.isError = true;
    render(<ModelMetricsTab />, { wrapper: TestWrapper });
    expect(screen.getByRole('tab', { name: 'Spend' })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(metricsState.refetch).toHaveBeenCalledTimes(1);
  });

  it('does not render the empty state in the Spend panel, and Refresh there busts spend', () => {
    metricsState.data = [];
    render(<ModelMetricsTab />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByRole('tab', { name: 'Spend' }));
    expect(screen.getByTestId('spend')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('model-metrics-refresh-btn'));
    expect(recacheSpend).toHaveBeenCalledTimes(1);
  });

  it('omits the header count at the server row cap', () => {
    metricsState.data = Array.from({ length: 500 }, (_, i) => ({ id: `m${i}` }));
    render(<ModelMetricsTab />, { wrapper: TestWrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.queryByText('500')).not.toBeInTheDocument();
  });

  it('disables Export CSV while the rows are placeholder data', () => {
    metricsState.isPlaceholderData = true;
    render(<ModelMetricsTab />, { wrapper: TestWrapper });
    expect(screen.getByTestId('model-metrics-export-btn')).toBeDisabled();
  });
});

describe('ModelMetricsTab - filters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves URL filters into the query and keeps the same filters across rerenders', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-10T12:00:00.000Z'));
    urlState.filters = { period: '24h', model: 'model-a', status: 'error' };
    const { rerender } = render(<ModelMetricsTab />, { wrapper: TestWrapper });
    const first = lastMetricsFilters();
    expect(first).toMatchObject({ modelFilter: 'model-a', statusFilter: 'error', userFilter: undefined });
    expect(first.dateFrom).toBe('2026-03-09T12:00:00.000Z');
    expect(first.dateTo).toBe('2026-03-10T12:00:00.000Z');

    rerender(<ModelMetricsTab />);
    // Same reference: a memo-less dayjs() per render would churn the react-query key.
    expect(lastMetricsFilters()).toBe(first);
  });

  it('passes a picked user to the metrics query', () => {
    metricsState.data = [];
    render(<ModelMetricsTab />, { wrapper: TestWrapper });
    expect(lastMetricsFilters().userFilter).toBeUndefined();
    fireEvent.click(screen.getByTestId('stub-pick-user'));
    expect(lastMetricsFilters().userFilter).toBe('user-1');
  });

  it('treats a period outside the presets as unset', () => {
    urlState.filters = { period: '90d', model: '', status: '' };
    metricsState.data = [];
    render(<ModelMetricsTab />, { wrapper: TestWrapper });
    expect(lastMetricsFilters().dateFrom).toBeUndefined();
    expect(screen.getByTestId('admin-empty-state')).toHaveTextContent('No model calls yet');
  });

  it('clears URL and user filters from the filtered empty state', () => {
    urlState.filters = { period: '', model: 'model-a', status: '' };
    metricsState.data = [];
    render(<ModelMetricsTab />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('stub-pick-user'));
    expect(screen.getByTestId('toolbar')).toHaveAttribute('data-user', 'user-1');
    expect(screen.getByTestId('admin-empty-state')).toHaveTextContent('No model calls match these filters');

    fireEvent.click(screen.getByTestId('model-metrics-clear-filters-btn'));
    expect(updateUrlState).toHaveBeenCalledWith({ filters: { period: '', model: '', status: '' } });
    expect(screen.getByTestId('toolbar')).toHaveAttribute('data-user', '');
  });

  it('counts a user filter alone as a filter', () => {
    metricsState.data = [];
    render(<ModelMetricsTab />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('stub-pick-user'));
    expect(screen.getByTestId('admin-empty-state')).toHaveTextContent('No model calls match these filters');
  });
});
