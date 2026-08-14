import React from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  LinearProgress,
  Stack,
  ToggleButtonGroup,
  Typography,
} from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { IDataLakeSpendResponse } from '@bike4mind/common';
import { formatUsd } from '@client/app/components/admin/CreditAnalysis/utils/format';
import { BreakdownTable } from '@client/app/components/admin/CreditAnalysis/components/BreakdownTable';

const DAY_RANGES = [30, 60, 90] as const;
type DayRange = (typeof DAY_RANGES)[number];

const microToUsd = (microUsd: number) => microUsd / 1_000_000;

const budgetProgressColor = (pct: number): 'primary' | 'warning' | 'danger' => {
  if (pct >= 100) return 'danger';
  if (pct >= 80) return 'warning';
  return 'primary';
};

export interface DataLakeSpendPanelProps {
  summary: IDataLakeSpendResponse | undefined;
  days: DayRange;
  onDaysChange: (days: DayRange) => void;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  onRefetch: () => void;
}

/**
 * Owner-facing spend view for one data lake (#1677). Pure/presentational - all data comes via
 * props, no fetching here - so it needs no QueryClientProvider in tests.
 */
export function DataLakeSpendPanel({
  summary,
  days,
  onDaysChange,
  isLoading,
  isFetching,
  error,
  onRefetch,
}: DataLakeSpendPanelProps) {
  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }} data-testid="datalake-spend-loading">
        <CircularProgress size="sm" />
      </Box>
    );
  }

  if (error) {
    return (
      <Alert color="danger" size="sm" data-testid="datalake-spend-error">
        Could not load spend for this data lake. Try again shortly.
      </Alert>
    );
  }

  if (!summary) return null;

  const lifetimeUsd = summary.embeddingSpendMicroUsd !== null ? microToUsd(summary.embeddingSpendMicroUsd) : null;
  const windowUsd = summary.ledger.totals.cogsUsd;
  const lakeBudgetUsd = microToUsd(summary.perLakeBudgetMicroUsd);
  const periodBudgetUsd = microToUsd(summary.perPeriodBudgetMicroUsd);
  const runBudgetUsd = microToUsd(summary.perRunBudgetMicroUsd);
  const lakePct =
    summary.perLakeBudgetMicroUsd > 0 && summary.embeddingSpendMicroUsd !== null
      ? (summary.embeddingSpendMicroUsd / summary.perLakeBudgetMicroUsd) * 100
      : null;

  // A lake with no ledger rows yet is either brand-new (lifetime meter also 0) or predates this
  // feature's ship date (lifetime meter nonzero) - the two need distinct copy.
  const hasNoLedgerRows = summary.ledger.totals.requests === 0;
  const isBrandNew = hasNoLedgerRows && (summary.embeddingSpendMicroUsd ?? 0) === 0;
  const predatesLedger = hasNoLedgerRows && (summary.embeddingSpendMicroUsd ?? 0) > 0;

  return (
    <Stack gap={2} data-testid="datalake-spend-panel">
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <ToggleButtonGroup
          size="sm"
          value={String(days)}
          onChange={(_e, value) => value && onDaysChange(Number(value) as DayRange)}
          data-testid="datalake-spend-range-toggle"
        >
          {DAY_RANGES.map(range => (
            <Button key={range} value={String(range)}>
              {range}d
            </Button>
          ))}
        </ToggleButtonGroup>
        <IconButton
          size="sm"
          variant="plain"
          onClick={onRefetch}
          loading={isFetching}
          data-testid="datalake-spend-refresh-btn"
        >
          <RefreshIcon fontSize="small" />
        </IconButton>
      </Stack>

      <Alert size="sm" variant="soft" color="neutral">
        This is recorded cost attributed to this lake, not credits charged to you.
      </Alert>

      <Stack direction="row" gap={1} flexWrap="wrap">
        <Chip data-testid="datalake-spend-lifetime" variant="soft">
          Lifetime: {lifetimeUsd !== null ? formatUsd(lifetimeUsd) : 'n/a'}
        </Chip>
        <Chip data-testid="datalake-spend-window-total" variant="soft">
          Last {days}d: {formatUsd(windowUsd)}
        </Chip>
      </Stack>

      {!summary.spendEnabled ? (
        <Alert size="sm" color="neutral" data-testid="datalake-spend-disabled-alert">
          Spend limits are turned off for this deployment; totals above are informational.
        </Alert>
      ) : (
        <Stack gap={1.5}>
          {summary.perLakeBudgetMicroUsd > 0 && lakePct !== null ? (
            <Box data-testid="datalake-spend-lake-progress">
              <Typography level="body-sm">
                Per-lake budget: {formatUsd(lifetimeUsd ?? 0)} of {formatUsd(lakeBudgetUsd)} ({Math.round(lakePct)}%)
              </Typography>
              <LinearProgress
                determinate
                value={Math.min(lakePct, 100)}
                color={budgetProgressColor(lakePct)}
                sx={{ mt: 0.5 }}
              />
            </Box>
          ) : (
            <Typography level="body-sm" data-testid="datalake-spend-period-uncapped">
              Per-lake budget: uncapped
            </Typography>
          )}
          <Typography level="body-sm" data-testid="datalake-spend-perrun-cap">
            Per-run budget: {formatUsd(runBudgetUsd)} (applies per upload batch)
          </Typography>
          <Typography level="body-sm">
            Platform-wide budget: {formatUsd(periodBudgetUsd)} per {summary.periodHours}h (shared across every lake)
          </Typography>
        </Stack>
      )}

      {isBrandNew ? (
        <Typography level="body-sm" color="neutral" data-testid="datalake-spend-empty">
          No embedding spend recorded yet. Costs appear here after the first file is indexed.
        </Typography>
      ) : predatesLedger ? (
        <Typography level="body-sm" color="neutral" data-testid="datalake-spend-empty">
          Detailed breakdown is available for spend recorded since this feature shipped; the lifetime total above
          includes earlier spend.
        </Typography>
      ) : (
        <Stack gap={2}>
          <BreakdownTable
            title="By model"
            testid="datalake-spend-model-table"
            keyLabel="Model"
            rows={summary.ledger.byModel.map(r => ({
              key: `${r.provider}-${r.model}`,
              label: `${r.provider} / ${r.model}`,
              requests: r.requests,
              cogsUsd: r.cogsUsd,
              creditsCharged: r.creditsCharged,
            }))}
          />
          <BreakdownTable
            title="By day"
            testid="datalake-spend-overtime-table"
            keyLabel="Day"
            rows={summary.ledger.overTime.map(r => ({
              key: r.day,
              label: r.day,
              requests: r.requests,
              cogsUsd: r.cogsUsd,
              creditsCharged: r.creditsCharged,
            }))}
          />
        </Stack>
      )}
    </Stack>
  );
}
