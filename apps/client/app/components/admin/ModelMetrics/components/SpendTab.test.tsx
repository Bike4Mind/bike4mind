import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { SpendTab, SpendTabView } from './SpendTab';
import { spendMockData, type SpendData } from '../utils/spendMockData';

// Controls what the container's data hook returns per test.
const mockUseSpend = vi.fn();
vi.mock('../hooks/useSpend', () => ({
  useSpend: (...args: unknown[]) => mockUseSpend(...args),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('SpendTabView', () => {
  it('renders the period label', () => {
    render(<SpendTabView data={spendMockData} />, { wrapper: TestWrapper });
    expect(screen.getByTestId('spend-period-label')).toHaveTextContent('Last 30 days vs Prior 30 days');
  });

  it('renders one KPI card per KPI', () => {
    render(<SpendTabView data={spendMockData} />, { wrapper: TestWrapper });
    const row = screen.getByTestId('spend-kpi-row');
    for (const kpi of spendMockData.kpis) {
      expect(within(row).getByText(kpi.label)).toBeInTheDocument();
    }
  });

  it('renders a spend-by-account row for every account', () => {
    render(<SpendTabView data={spendMockData} />, { wrapper: TestWrapper });
    const table = screen.getByTestId('spend-by-account-table');
    for (const account of spendMockData.byAccount) {
      expect(within(table).getByText(account.accountName)).toBeInTheDocument();
    }
  });

  it('renders a cost-by-model bar for every model', () => {
    render(<SpendTabView data={spendMockData} />, { wrapper: TestWrapper });
    const bars = screen.getByTestId('spend-by-model-bars');
    for (const model of spendMockData.byModel) {
      expect(within(bars).getByText(model.modelName)).toBeInTheDocument();
    }
  });

  it('colors a rising cost metric red (higherIsBetter=false) and a rising good metric green', () => {
    const data: SpendData = {
      ...spendMockData,
      kpis: [
        { key: 'estCost', label: 'Est. Cost', value: 200, priorValue: 100, format: 'currency', higherIsBetter: false },
        { key: 'requests', label: 'Requests', value: 200, priorValue: 100, format: 'number', higherIsBetter: true },
      ],
    };
    render(<SpendTabView data={data} />, { wrapper: TestWrapper });

    // Both rose +100%, but the sign of higherIsBetter flips the semantic color.
    const costDelta = screen.getByTestId('spend-kpi-delta-estCost');
    expect(costDelta).toHaveTextContent('100.0%');
    expect(costDelta.className).toMatch(/colorDanger/);
    expect(costDelta).toHaveAttribute('title', 'Increased 100.0% vs prior period');

    const requestsDelta = screen.getByTestId('spend-kpi-delta-requests');
    expect(requestsDelta.className).toMatch(/colorSuccess/);
  });

  it('formats the ms and percent KPI branches', () => {
    render(<SpendTabView data={spendMockData} />, { wrapper: TestWrapper });
    const row = screen.getByTestId('spend-kpi-row');
    // p50Latency 812 -> "812ms" (ms branch), errorRate 0.021 -> "2.1%" (percent branch).
    expect(within(row).getByText('812ms')).toBeInTheDocument();
    expect(within(row).getByText('2.1%')).toBeInTheDocument();
  });

  it('shows a no-prior-data chip when a KPI has a zero prior value', () => {
    const data: SpendData = {
      ...spendMockData,
      kpis: [
        { key: 'estCost', label: 'Est. Cost', value: 10, priorValue: 0, format: 'currency', higherIsBetter: false },
      ],
    };
    render(<SpendTabView data={data} />, { wrapper: TestWrapper });
    const chip = screen.getByTestId('spend-kpi-delta-estCost');
    expect(chip).toHaveTextContent('--');
    expect(chip).toHaveAttribute('title', 'No prior-period data');
  });

  it('renders account, model, and period data from the data prop', () => {
    const data: SpendData = {
      periodLabel: 'Custom period',
      priorPeriodLabel: 'Custom prior',
      kpis: [
        { key: 'estCost', label: 'Est. Cost', value: 10, priorValue: 5, format: 'currency', higherIsBetter: false },
      ],
      byAccount: [
        {
          accountId: 'x1',
          accountName: 'Zzyzx Corp',
          estCost: 12.34,
          requests: 5,
          creditsUsed: 1234,
          costPerRequest: 2.468,
        },
      ],
      byModel: [{ modelId: 'm1', modelName: 'Custom Model One', estCost: 12.34, requests: 5, share: 1 }],
      dailyCost: [
        { date: '2026-01-01', cost: 1 },
        { date: '2026-01-02', cost: 2 },
      ],
    };
    render(<SpendTabView data={data} />, { wrapper: TestWrapper });

    expect(screen.getByText('Custom period vs Custom prior')).toBeInTheDocument();
    expect(within(screen.getByTestId('spend-by-account-table')).getByText('Zzyzx Corp')).toBeInTheDocument();
    expect(within(screen.getByTestId('spend-by-model-bars')).getByText('Custom Model One')).toBeInTheDocument();
  });
});

describe('SpendTab (container)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes the shared filters through to useSpend', () => {
    mockUseSpend.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    render(<SpendTab filters={{ dateFrom: '2026-01-01', userFilter: 'u-1' }} />, { wrapper: TestWrapper });
    expect(mockUseSpend).toHaveBeenCalledWith({
      dateFrom: '2026-01-01',
      dateTo: undefined,
      userFilter: 'u-1',
      modelFilter: undefined,
    });
  });

  it('renders a loading state while fetching', () => {
    mockUseSpend.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    render(<SpendTab />, { wrapper: TestWrapper });
    expect(screen.getByTestId('spend-loading')).toBeInTheDocument();
  });

  it('renders an error state when the query fails', () => {
    mockUseSpend.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    render(<SpendTab />, { wrapper: TestWrapper });
    expect(screen.getByTestId('spend-error')).toBeInTheDocument();
  });

  it('renders an empty state when there is no spend in the window', () => {
    mockUseSpend.mockReturnValue({
      data: { ...spendMockData, byAccount: [], dailyCost: [] },
      isLoading: false,
      isError: false,
    });
    render(<SpendTab />, { wrapper: TestWrapper });
    expect(screen.getByTestId('spend-empty')).toBeInTheDocument();
  });

  it('renders the view once data arrives', () => {
    mockUseSpend.mockReturnValue({ data: spendMockData, isLoading: false, isError: false });
    render(<SpendTab />, { wrapper: TestWrapper });
    expect(screen.getByTestId('spend-kpi-row')).toBeInTheDocument();
  });
});
