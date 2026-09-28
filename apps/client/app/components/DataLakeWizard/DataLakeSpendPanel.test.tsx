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
    expect(screen.getByTestId('datalake-spend-feature-table')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-spend-overtime-table')).toBeInTheDocument();
  });

  // #3298: research judge cost reaches the ledger under feature 'operations', but a curator who
  // never touched an upload would not recognize that name - this is the one place it says "Research".
  it('labels research and ingestion spend distinctly in the by-feature breakdown', () => {
    renderPanel({
      summary: baseSummary({
        embeddingSpendMicroUsd: 5_000_000,
        ledger: {
          ...emptyLedger,
          byFeature: [
            { feature: 'embedding', requests: 3, cogsUsd: 4, creditsCharged: 0 },
            { feature: 'operations', requests: 12, cogsUsd: 1, creditsCharged: 0 },
          ],
          totals: { requests: 15, cogsUsd: 5, creditsCharged: 0 },
        },
      }),
    });
    expect(screen.getByText('File ingestion')).toBeInTheDocument();
    expect(screen.getByText('Research')).toBeInTheDocument();
  });

  // A feature this build does not know a friendly label for must still render something legible
  // rather than crash the table - same defensive-degrade rule LakeConfigHistorySection follows.
  it('falls back to the raw feature name for one this build has no label for', () => {
    renderPanel({
      summary: baseSummary({
        embeddingSpendMicroUsd: 1,
        ledger: {
          ...emptyLedger,
          byFeature: [{ feature: 'chat', requests: 1, cogsUsd: 1, creditsCharged: 0 }],
          totals: { requests: 1, cogsUsd: 1, creditsCharged: 0 },
        },
      }),
    });
    expect(screen.getByText('chat')).toBeInTheDocument();
  });

  // #3298: the by-day breakdown buckets in UTC, so an evening run showed up under the next day
  // with nothing telling the viewer why - the fix is labeling the bucket, not re-deriving it.
  it("labels the by-day breakdown as UTC rather than implying the viewer's own timezone", () => {
    renderPanel({
      summary: baseSummary({
        embeddingSpendMicroUsd: 1,
        ledger: { ...emptyLedger, totals: { requests: 1, cogsUsd: 1, creditsCharged: 0 } },
      }),
    });
    expect(screen.getByText('By day (UTC)')).toBeInTheDocument();
  });

  // #3298: the copy cited the per-upload-batch budget even when the spend on screen came from a
  // research run, which never touches an upload batch at all.
  it("names the per-run budget as an ingestion figure, distinct from a research run's own ceiling", () => {
    renderPanel();
    const copy = screen.getByTestId('datalake-spend-perrun-cap');
    expect(copy).toHaveTextContent(/ingestion per-run budget/i);
    expect(copy).toHaveTextContent(/research run has its own cost ceiling/i);
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
