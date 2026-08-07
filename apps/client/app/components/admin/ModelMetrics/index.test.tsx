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

vi.mock('./hooks/useModelMetrics', () => ({
  useModelMetrics: () => ({ data: [], isLoading: false, recache: recacheModel }),
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

// Stub the heavy children; the ControlPanel stub exposes the Refresh action.
vi.mock('./components/ControlPanel', () => ({
  ControlPanel: (props: { onRefresh: () => void }) => (
    <button data-testid="ctrl-refresh" onClick={props.onRefresh}>
      refresh
    </button>
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

const lastUseSpendCall = () => useSpendSpy.mock.calls.at(-1) as [unknown, { enabled: boolean }];

describe('ModelMetricsTab - Spend wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    fireEvent.click(screen.getByTestId('ctrl-refresh'));
    expect(recacheModel).toHaveBeenCalledTimes(1);
    expect(recacheSpend).not.toHaveBeenCalled();
  });

  it('Refresh busts the spend cache when the Spend tab is active', () => {
    render(<ModelMetricsTab />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByRole('tab', { name: /Spend/ }));
    fireEvent.click(screen.getByTestId('ctrl-refresh'));
    expect(recacheSpend).toHaveBeenCalledTimes(1);
    expect(recacheModel).not.toHaveBeenCalled();
  });
});
