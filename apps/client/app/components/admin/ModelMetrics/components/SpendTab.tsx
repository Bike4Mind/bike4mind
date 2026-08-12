import React from 'react';
import { Box, Chip, LinearProgress, Sheet, Stack, Table, Typography } from '@mui/joy';
import { useTheme } from '@mui/joy/styles';
import { ResponsiveLine } from '@nivo/line';
import { type SpendData, type SpendKpi, type SpendKpiFormat } from '@bike4mind/common';

// Nivo's generics fight strict TS here; the same assertion is used in AnalyticsTab.
const ResponsiveLineChart = ResponsiveLine as any;

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

export const SpendTabView: React.FC<SpendTabViewProps> = ({ data }) => {
  const theme = useTheme();

  // Duplicated from AnalyticsTab's chartTheme (hand-rolled, not shared code).
  const chartTheme = {
    axis: {
      ticks: { text: { fill: theme.palette.text.tertiary } },
      legend: { text: { fill: theme.palette.text.primary } },
    },
    grid: { line: { stroke: theme.palette.divider } },
    tooltip: {
      container: {
        background: theme.palette.background.surface,
        color: theme.palette.text.primary,
        boxShadow: theme.shadow.md,
        borderRadius: theme.radius.md,
      },
    },
  };

  const maxModelCost = Math.max(...data.byModel.map(m => m.estCost), 0);

  // The by-account table is capped server-side; data.activeAccounts is the true
  // distinct count, so surface "top N of M" when the list is partial.
  const accountsTruncated = data.byAccount.length < data.activeAccounts;

  const lineData = [
    {
      id: 'Daily Cost',
      data: data.dailyCost.map(point => ({ x: point.date, y: point.cost })),
    },
  ];

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
          {accountsTruncated ? 'Top Spend by Account' : 'Spend by Account'}
        </Typography>
        {accountsTruncated && (
          <Typography level="body-xs" sx={{ color: 'text.secondary', mb: 2 }} data-testid="spend-account-truncation">
            Showing top {data.byAccount.length.toLocaleString('en-US')} of {data.activeAccounts.toLocaleString('en-US')}{' '}
            accounts by spend.
          </Typography>
        )}
        {/* Bounded height gives Table stickyHeader a scroll container to stick within. */}
        <Sheet variant="outlined" sx={{ borderRadius: 'md', overflow: 'auto', maxHeight: 480 }}>
          <Table stickyHeader hoverRow size="sm" data-testid="spend-by-account-table">
            <thead>
              <tr>
                <th>Account</th>
                <th style={{ textAlign: 'right' }}>Est. Cost</th>
                <th style={{ textAlign: 'right' }}>Requests</th>
                <th style={{ textAlign: 'right' }}>Credits</th>
                <th style={{ textAlign: 'right' }}>Cost / Req</th>
              </tr>
            </thead>
            <tbody>
              {data.byAccount.map(row => (
                <tr key={row.accountId}>
                  <td>{row.accountName}</td>
                  <td style={{ textAlign: 'right' }}>{formatKpiValue(row.estCost, 'currency')}</td>
                  <td style={{ textAlign: 'right' }}>{row.requests.toLocaleString('en-US')}</td>
                  <td style={{ textAlign: 'right' }}>{row.creditsUsed.toLocaleString('en-US')}</td>
                  <td style={{ textAlign: 'right' }}>${row.costPerRequest.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Sheet>
      </Box>

      {/* Section 3: Cost by model (bar table) */}
      <Box>
        <Typography level="h4" sx={{ mb: 2 }}>
          Cost by Model
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
          Daily Cost
        </Typography>
        <Box sx={{ height: 300 }} data-testid="spend-daily-cost-chart">
          <ResponsiveLineChart
            data={lineData}
            theme={chartTheme}
            margin={{ top: 20, right: 30, bottom: 70, left: 60 }}
            xScale={{ type: 'point' }}
            yScale={{ type: 'linear', min: 'auto', max: 'auto' }}
            curve="catmullRom"
            axisTop={null}
            axisRight={null}
            axisBottom={{
              tickSize: 5,
              tickPadding: 5,
              tickRotation: -45,
              legend: 'Date',
              legendPosition: 'middle',
              legendOffset: 55,
              format: (value: string) => value.slice(5),
            }}
            axisLeft={{
              tickSize: 5,
              tickPadding: 5,
              tickRotation: 0,
              legend: 'Cost (USD)',
              legendPosition: 'middle',
              legendOffset: -50,
              format: (value: number) => `$${value}`,
            }}
            pointSize={6}
            pointColor={theme.palette.background.surface}
            pointBorderWidth={2}
            pointBorderColor={{ from: 'serieColor' }}
            enableArea={true}
            areaOpacity={0.15}
            useMesh={true}
            colors={[theme.palette.primary[500]]}
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
