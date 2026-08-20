import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IDataLakeSpendResponse } from '@bike4mind/common';
import { DataLakeSpendPanel } from './DataLakeSpendPanel';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const emptyLedger = {
  overTime: [],
  byModel: [],
  byFeature: [],
  totals: { requests: 0, cogsUsd: 0, creditsCharged: 0 },
};

const baseSummary = (overrides: Partial<IDataLakeSpendResponse> = {}): IDataLakeSpendResponse => ({
  dataLakeId: 'lake-1',
  days: 30,
  embeddingSpendMicroUsd: 0,
  spendEnabled: true,
  perRunBudgetMicroUsd: 5_000_000,
  perLakeBudgetMicroUsd: 100_000_000,
  perPeriodBudgetMicroUsd: 50_000_000,
  periodHours: 24,
  tierMultiplier: 1,
  ledger: emptyLedger,
  ...overrides,
});

const renderPanel = (props: Partial<React.ComponentProps<typeof DataLakeSpendPanel>> = {}) =>
  render(
    <Wrapper>
      <DataLakeSpendPanel
        summary={baseSummary()}
        days={30}
        onDaysChange={vi.fn()}
        isLoading={false}
        isFetching={false}
        error={null}
        onRefetch={vi.fn()}
        {...props}
      />
    </Wrapper>
  );

describe('DataLakeSpendPanel', () => {
  it('shows a loading indicator while loading', () => {
    renderPanel({ isLoading: true, summary: undefined });
    expect(screen.getByTestId('datalake-spend-loading')).toBeInTheDocument();
  });

  it('shows an error state without a full crash', () => {
    renderPanel({ error: new Error('boom'), summary: undefined });
    expect(screen.getByTestId('datalake-spend-error')).toBeInTheDocument();
  });

  it('shows the empty state for a brand-new lake (lifetime 0, no ledger rows)', () => {
    renderPanel({ summary: baseSummary({ embeddingSpendMicroUsd: 0 }) });
    expect(screen.getByTestId('datalake-spend-empty')).toHaveTextContent(/first file is indexed/i);
  });

  it('shows a distinct message for a lake that predates the ledger (lifetime > 0, no rows)', () => {
    renderPanel({ summary: baseSummary({ embeddingSpendMicroUsd: 5_000_000 }) });
    expect(screen.getByTestId('datalake-spend-empty')).toHaveTextContent(/since this feature shipped/i);
  });

  it('renders breakdown tables once ledger rows exist', () => {
    renderPanel({
      summary: baseSummary({
        embeddingSpendMicroUsd: 5_000_000,
        ledger: {
          ...emptyLedger,
          byModel: [
            { provider: 'openai', model: 'text-embedding-3-small', requests: 2, cogsUsd: 5, creditsCharged: 0 },
          ],
          totals: { requests: 2, cogsUsd: 5, creditsCharged: 0 },
        },
      }),
    });
    expect(screen.queryByTestId('datalake-spend-empty')).not.toBeInTheDocument();
    expect(screen.getByTestId('datalake-spend-model-table')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-spend-overtime-table')).toBeInTheDocument();
  });

  it('shows the halted-indexing alert (not an "off = unconstrained" reading) when spendEnabled is false', () => {
    renderPanel({ summary: baseSummary({ spendEnabled: false }) });
    const alert = screen.getByTestId('datalake-spend-disabled-alert');
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent(/indexing is paused/i);
    expect(alert).not.toHaveTextContent(/turned off/i);
    expect(screen.queryByTestId('datalake-spend-lake-progress')).not.toBeInTheDocument();
  });

  it('shows an uncapped label instead of a progress bar when the per-lake budget is 0', () => {
    renderPanel({ summary: baseSummary({ perLakeBudgetMicroUsd: 0 }) });
    expect(screen.getByTestId('datalake-spend-lake-uncapped')).toBeInTheDocument();
  });

  it('clamps the progress bar visually past 100% but shows the true percentage in the label', () => {
    renderPanel({
      summary: baseSummary({ embeddingSpendMicroUsd: 140_000_000, perLakeBudgetMicroUsd: 100_000_000 }),
    });
    const progress = screen.getByTestId('datalake-spend-lake-progress');
    expect(progress).toHaveTextContent('140%');
  });

  it('formats a sub-cent lifetime total via the shared formatUsd floor, not as $0.00', () => {
    renderPanel({
      summary: baseSummary({
        embeddingSpendMicroUsd: 50,
        ledger: { ...emptyLedger, totals: { requests: 1, cogsUsd: 0.00005, creditsCharged: 0 } },
      }),
    });
    expect(screen.getByTestId('datalake-spend-lifetime')).toHaveTextContent('<$0.0001');
  });
});
