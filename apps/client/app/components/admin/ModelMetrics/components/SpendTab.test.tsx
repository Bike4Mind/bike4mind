import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { SpendTab } from './SpendTab';
import { spendMockData, type SpendData } from '../utils/spendMockData';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('SpendTab', () => {
  it('renders the mockup badge so reviewers know the data is fake', () => {
    render(<SpendTab />, { wrapper: TestWrapper });
    expect(screen.getByTestId('spend-mockup-badge')).toHaveTextContent('MOCKUP - FAKE DATA');
  });

  it('renders one KPI card per fixture KPI', () => {
    render(<SpendTab />, { wrapper: TestWrapper });
    const row = screen.getByTestId('spend-kpi-row');
    for (const kpi of spendMockData.kpis) {
      expect(within(row).getByText(kpi.label)).toBeInTheDocument();
    }
  });

  it('renders a spend-by-account row for every account', () => {
    render(<SpendTab />, { wrapper: TestWrapper });
    const table = screen.getByTestId('spend-by-account-table');
    for (const account of spendMockData.byAccount) {
      expect(within(table).getByText(account.accountName)).toBeInTheDocument();
    }
  });

  it('renders a cost-by-model bar for every model', () => {
    render(<SpendTab />, { wrapper: TestWrapper });
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
    render(<SpendTab data={data} />, { wrapper: TestWrapper });

    // Both rose +100%, but the sign of higherIsBetter flips the semantic color.
    const costDelta = screen.getByTestId('spend-kpi-delta-estCost');
    expect(costDelta).toHaveTextContent('100.0%');
    expect(costDelta.className).toMatch(/colorDanger/);
    expect(costDelta).toHaveAttribute('title', 'Increased 100.0% vs prior period');

    const requestsDelta = screen.getByTestId('spend-kpi-delta-requests');
    expect(requestsDelta.className).toMatch(/colorSuccess/);
  });
});
