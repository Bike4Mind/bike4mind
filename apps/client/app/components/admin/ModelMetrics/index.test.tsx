import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

// Shared mock handles (hoisted so the vi.mock factories can close over them).
const { recacheModel, recacheSpend, useSpendSpy } = vi.hoisted(() => ({
  recacheModel: vi.fn(),
  recacheSpend: vi.fn(),
  useSpendSpy: vi.fn(),
}));

const { metricsState } = vi.hoisted(() => ({
  metricsState: {
    data: [{ id: 'm1' }] as unknown[],
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  },
}));
vi.mock('./hooks/useModelMetrics', () => ({
  useModelMetrics: () => ({ ...metricsState, recache: recacheModel }),
}));
vi.mock('@client/app/components/admin/shared/useAdminListUrlState', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/components/admin/shared/useAdminListUrlState')>()),
  useAdminListUrlState: () => [{ query: '', view: '', filters: { period: '', model: '', status: '' } }, vi.fn()],
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

vi.mock('./components/ControlPanel', () => ({ ControlPanel: () => <div data-testid="toolbar" /> }));
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

const lastUseSpendCall = () => useSpendSpy.mock.calls.at(-1) as [unknown, { enabled: boolean }];

describe('ModelMetricsTab - Spend wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(metricsState, { data: [{ id: 'm1' }], isLoading: false, isFetching: false, isError: false });
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
    render(<ModelMetricsTab />, { wrapper: TestWrapper });
    expect(lastUseSpendCall()[0]).toEqual({
      dateFrom: undefined,
      dateTo: undefined,
      userFilter: undefined,
      modelFilter: undefined,
    });
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
    Object.assign(metricsState, { data: [{ id: 'm1' }], isLoading: false, isFetching: false, isError: false });
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

  it('shows the empty state when there are no rows', () => {
    metricsState.data = [];
    render(<ModelMetricsTab />, { wrapper: TestWrapper });
    expect(screen.getByTestId('admin-empty-state')).toHaveTextContent('No model calls in this period');
    expect(screen.getByTestId('toolbar')).toBeInTheDocument();
  });

  it('shows the error state with a retry when the query fails', () => {
    metricsState.data = [];
    metricsState.isError = true;
    render(<ModelMetricsTab />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(metricsState.refetch).toHaveBeenCalledTimes(1);
  });
});
