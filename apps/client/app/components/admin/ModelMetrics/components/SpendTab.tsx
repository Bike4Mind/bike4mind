import React from 'react';
import { Box, Chip, LinearProgress, Sheet, Stack, Typography } from '@mui/joy';
import Alert from '@mui/joy/Alert';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import {
  SPEND_ACCOUNT_FLAG_THRESHOLDS,
  type SpendAccountFlag,
  type SpendData,
  type SpendKpi,
  type SpendKpiFormat,
} from '@bike4mind/common';
import { TrendAreaChart } from '@client/app/components/Charts/TrendAreaChart';
import { DataTable, EmptyState, type DataColumn } from '../../shared';
import { adminChartSeries, adminChartStyle } from '../../EventMetrics/utils/chartTheme';

interface SpendTabProps {
  /** Live spend for the selected window; the parent owns the useSpend query. */
  data?: SpendData;
  isLoading?: boolean;
  isError?: boolean;
}

interface SpendTabViewProps {
  data: SpendData;
}

const formatKpiValue = (value: number, format: SpendKpiFormat): string => {
  switch (format) {
    case 'currency':
      return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    case 'currencyPrecise':
      return `$${value.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
    case 'number':
      return value.toLocaleString('en-US');
    case 'ms':
      return `${Math.round(value).toLocaleString('en-US')}ms`;
    case 'percent':
      return `${(value * 100).toFixed(1)}%`;
    default:
      return String(value);
  }
};

const T = SPEND_ACCOUNT_FLAG_THRESHOLDS;

/** Chip label and the limit it stands for, in the order the server emits flags. */
const FLAG_INFO: Record<SpendAccountFlag, { label: string; limit: string }> = {
  dailyCost: { label: 'Cost/day', limit: `over ${formatKpiValue(T.dailyCostUsd, 'currency')}/day on average` },
  errorRate: { label: 'Errors', limit: `error rate over ${formatKpiValue(T.errorRate, 'percent')}` },
  p95Latency: { label: 'p95', limit: `p95 latency over ${T.p95LatencyMs / 1000}s` },
};

const FLAG_RULES = `Flagged for ${Object.values(FLAG_INFO)
  .map(f => f.limit)
  .join(', ')}. Error rate and latency need at least ${T.minRequests} requests.`;

const FlagBanner: React.FC<{ flaggedCount: number }> = ({ flaggedCount }) => (
  <Alert
    color="warning"
    variant="soft"
    startDecorator={<WarningAmberIcon />}
    sx={{ mb: 2 }}
    data-testid="spend-account-flag-banner"
  >
    <Box>
      <Typography level="title-sm">
        {flaggedCount.toLocaleString('en-US')} {flaggedCount === 1 ? 'account is' : 'accounts are'} over a limit
      </Typography>
      <Typography level="body-xs">{FLAG_RULES}</Typography>
    </Box>
  </Alert>
);

/** Percent change vs the prior period; null when there is no prior baseline. */
const computeDelta = (value: number, priorValue: number): number | null => {
  if (!priorValue) return null;
  return (value - priorValue) / priorValue;
};

const DeltaChip: React.FC<{ delta: number | null; higherIsBetter: boolean; testId?: string }> = ({
  delta,
  higherIsBetter,
  testId,
}) => {
  if (delta === null) {
    return (
      <Chip size="sm" variant="soft" color="neutral" data-testid={testId} title="No prior-period data">
        --
      </Chip>
    );
  }
  const isFlat = Math.abs(delta) < 0.0005;
  const isPositiveChange = delta > 0;
  const isGood = isFlat ? true : isPositiveChange === higherIsBetter;
  // Escaped so the source stays ASCII per repo convention; renders as up/down arrows.
  const arrow = isFlat ? '' : isPositiveChange ? '\u2191' : '\u2193';
  const pct = `${Math.abs(delta * 100).toFixed(1)}%`;
  // The arrow is decorative; `title` carries the direction for screen readers.
  const direction = isFlat ? 'No change' : isPositiveChange ? 'Increased' : 'Decreased';
  return (
    <Chip
      size="sm"
      variant="soft"
      color={isFlat ? 'neutral' : isGood ? 'success' : 'danger'}
      data-testid={testId}
      title={`${direction} ${pct} vs prior period`}
    >
      <span aria-hidden="true">{arrow}</span>
      {pct}
    </Chip>
  );
};

const KpiCard: React.FC<{ kpi: SpendKpi }> = ({ kpi }) => {
  const delta = computeDelta(kpi.value, kpi.priorValue);
  return (
    <Box sx={{ p: 2, bgcolor: 'background.level1', borderRadius: 'md' }}>
      <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
        {kpi.label}
      </Typography>
      <Typography level="title-lg" sx={{ mt: 0.5 }}>
        {formatKpiValue(kpi.value, kpi.format)}
      </Typography>
      <Box sx={{ mt: 1 }}>
        <DeltaChip delta={delta} higherIsBetter={kpi.higherIsBetter} testId={`spend-kpi-delta-${kpi.key}`} />
      </Box>
    </Box>
  );
};

type SpendAccountRow = SpendData['byAccount'][number];

// DataTable requires a retry handler; the parent owns the spend query's error state and `empty` has no action.
const noRetry = () => undefined;

const accountColumns: DataColumn<SpendAccountRow>[] = [
  {
    id: 'account',
    label: 'Account',
    width: '14rem',
    wrap: true,
    render: row => (
      <Stack direction="row" spacing={0.5} alignItems="center" useFlexGap flexWrap="wrap">
        <span>{row.accountName}</span>
        {row.flags.map(flag => (
          <Chip
            key={flag}
            size="sm"
            variant="soft"
            color="warning"
            title={`Flagged: ${FLAG_INFO[flag].limit}`}
            data-testid={`spend-account-flag-${flag}`}
          >
            {FLAG_INFO[flag].label}
          </Chip>
        ))}
      </Stack>
    ),
  },
  {
    id: 'estCost',
    label: 'Est. cost',
    width: '7rem',
    numeric: true,
    render: row => formatKpiValue(row.estCost, 'currency'),
  },
  {
    id: 'requests',
    label: 'Requests',
    width: '7rem',
    numeric: true,
    render: row => row.requests.toLocaleString('en-US'),
  },
  {
    id: 'creditsUsed',
    label: 'Credits',
    width: '7rem',
    numeric: true,
    render: row => row.creditsUsed.toLocaleString('en-US'),
  },
  {
    id: 'costPerRequest',
    label: 'Cost / req',
    width: '7rem',
    numeric: true,
    render: row => `$${row.costPerRequest.toFixed(4)}`,
  },
  {
    id: 'errorRate',
    label: 'Error rate',
    width: '7rem',
    numeric: true,
    render: row => formatKpiValue(row.errorRate, 'percent'),
  },
  {
    id: 'p95',
    label: 'p95',
    width: '7rem',
    numeric: true,
    // 0 means no event carried latencyMs, not an instant response.
    render: row => (
      <span data-testid={`spend-account-p95-${row.accountId}`}>
        {row.p95LatencyMs > 0 ? formatKpiValue(row.p95LatencyMs, 'ms') : '--'}
      </span>
    ),
  },
];

export const SpendTabView: React.FC<SpendTabViewProps> = ({ data }) => {
  const maxModelCost = Math.max(...data.byModel.map(m => m.estCost), 0);

  // The by-account table is capped server-side; data.activeAccounts is the true
  // distinct count, so surface "top N of M" when the list is partial.
  const accountsTruncated = data.byAccount.length < data.activeAccounts;
  const flaggedCount = data.byAccount.filter(row => row.flags.length > 0).length;
  const dailyCost = data.dailyCost.map(point => ({ x: point.date, y: point.cost }));

  return (
    <Stack spacing={3} sx={{ mt: 1 }}>
      <Typography level="body-xs" sx={{ color: 'text.secondary' }} data-testid="spend-period-label">
        {data.periodLabel} vs {data.priorPeriodLabel}
      </Typography>

      {/* Section 1: KPI row */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(3, 1fr)', md: 'repeat(5, 1fr)' },
          gap: 2,
        }}
        data-testid="spend-kpi-row"
      >
        {data.kpis.map(kpi => (
          <KpiCard key={kpi.key} kpi={kpi} />
        ))}
      </Box>

      {/* Section 2: Spend by account */}
      <Box>
        <Typography level="h4" sx={{ mb: accountsTruncated ? 0.5 : 2 }}>
          {accountsTruncated ? 'Top spend by account' : 'Spend by account'}
        </Typography>
        {accountsTruncated && (
          <Typography level="body-xs" sx={{ color: 'text.secondary', mb: 2 }} data-testid="spend-account-truncation">
            Showing top {data.byAccount.length.toLocaleString('en-US')} of {data.activeAccounts.toLocaleString('en-US')}{' '}
            accounts by spend.
          </Typography>
        )}
        {flaggedCount > 0 && <FlagBanner flaggedCount={flaggedCount} />}
        <DataTable<SpendAccountRow>
          rows={data.byAccount}
          columns={accountColumns}
          getRowId={row => row.accountId}
          label="Spend by account"
          onRetry={noRetry}
          empty={<EmptyState title="No account spend in this window" action={null} />}
          testId="spend-by-account-table"
          rowTestId={row => `spend-account-row-${row.accountId}`}
          pagination={false}
          maxHeight="480px"
          minWidth="56rem"
        />
      </Box>

      {/* Section 3: Cost by model (bar table) */}
      <Box>
        <Typography level="h4" sx={{ mb: 2 }}>
          Cost by model
        </Typography>
        <Sheet variant="outlined" sx={{ borderRadius: 'md', p: 2 }}>
          <Stack spacing={1.5} data-testid="spend-by-model-bars">
            {data.byModel.map(model => (
              <Box key={model.modelId}>
                <Stack direction="row" justifyContent="space-between" alignItems="baseline" sx={{ mb: 0.5 }}>
                  <Typography level="body-sm">{model.modelName}</Typography>
                  <Stack direction="row" spacing={2} alignItems="baseline">
                    <Typography level="body-sm">{formatKpiValue(model.estCost, 'currency')}</Typography>
                    <Typography level="body-xs" sx={{ color: 'text.secondary', minWidth: 40, textAlign: 'right' }}>
                      {(model.share * 100).toFixed(0)}%
                    </Typography>
                  </Stack>
                </Stack>
                <Box
                  sx={{
                    height: 8,
                    borderRadius: 'sm',
                    bgcolor: 'background.level2',
                    overflow: 'hidden',
                  }}
                >
                  <Box
                    data-testid={`spend-model-bar-${model.modelId}`}
                    sx={{
                      height: '100%',
                      borderRadius: 'sm',
                      bgcolor: 'primary.500',
                      width: `${maxModelCost > 0 ? (model.estCost / maxModelCost) * 100 : 0}%`,
                    }}
                  />
                </Box>
              </Box>
            ))}
          </Stack>
        </Sheet>
      </Box>

      {/* Section 4: Daily cost line chart */}
      <Box>
        <Typography level="h4" sx={{ mb: 2 }}>
          Daily cost
        </Typography>
        <Box sx={{ height: 300 }} data-testid="spend-daily-cost-chart">
          <TrendAreaChart
            testId="spend-daily-cost-trend"
            data={dailyCost}
            color={adminChartSeries(1)[0]}
            style={adminChartStyle}
            xLegend="Date"
            yLegend="Cost (USD)"
            pointSize={6}
            yAxisWidth={70}
            formatX={value => value.slice(5)}
            formatY={value => `$${value}`}
          />
        </Box>
      </Box>
    </Stack>
  );
};

export const SpendTab: React.FC<SpendTabProps> = ({ data, isLoading, isError }) => {
  if (isError) {
    return (
      <Box sx={{ p: 2 }}>
        <Chip color="danger" variant="soft" size="sm" data-testid="spend-error">
          Failed to load spend data
        </Chip>
      </Box>
    );
  }

  // No data yet (fetching, or the query is gated off) reads as loading.
  if (isLoading || !data) {
    return (
      <Box sx={{ p: 2 }} data-testid="spend-loading">
        <LinearProgress />
        <Typography sx={{ mt: 2 }}>Loading spend data...</Typography>
      </Box>
    );
  }

  // Nothing settled in the window (authoritative flag, not inferred from a cut).
  if (!data.hasData) {
    return (
      <Box sx={{ p: 2 }} data-testid="spend-empty">
        <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
          No spend data for {data.periodLabel}.
        </Typography>
      </Box>
    );
  }

  return <SpendTabView data={data} />;
};
