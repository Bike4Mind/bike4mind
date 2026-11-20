import React from 'react';
import { Button, Stack, Typography } from '@mui/joy';
import { AdminPageHeader, DataTable, EmptyState, StatStrip, StatTile, StatusChip, type DataColumn } from './shared';

interface MetricData {
  totalRequests: number;
  successRate: number;
  averageLatency: number;
  averageTtfvtSavings: number | null;
  averageTtfvt: number | null;
  activeMappings: number;
}

interface ModelMetric {
  mainModel: string;
  rapidModel: string;
  usageCount: number;
  avgLatency: number;
  avgTtfvtSavings: number | null;
  avgTtfvt: number | null;
  successRate: number;
  totalCost?: number;
  tokensSaved?: number;
}

export interface RapidReplyMetricsData {
  metrics?: MetricData;
  activeMappings?: number;
  modelBreakdown?: ModelMetric[];
}

interface RapidReplyMetricsProps {
  metrics?: RapidReplyMetricsData | null;
  thresholds: {
    maxLatency: number;
    minSuccessRate: number;
  };
  /** The empty state's next step: mappings are what produce rapid replies. */
  onOpenModels: () => void;
}

const ms = (value: number | null | undefined) =>
  value === null || value === undefined ? undefined : `${Math.round(value).toLocaleString()} ms`;

const percent = (value: number | null | undefined) =>
  value === null || value === undefined ? undefined : `${value.toFixed(1)}%`;

const Dash = () => (
  <Typography component="span" sx={{ color: 'admin.inkMuted' }}>
    -
  </Typography>
);

export const RapidReplyMetrics: React.FC<RapidReplyMetricsProps> = ({ metrics, thresholds, onOpenModels }) => {
  const metricData = metrics?.metrics;
  // Fastest first until an admin sorts by a column.
  const modelBreakdown = [...(metrics?.modelBreakdown ?? [])].sort((a, b) => a.avgLatency - b.avgLatency);

  if (!metricData || !metricData.totalRequests) {
    return (
      <EmptyState
        title="No rapid replies yet"
        description="Metrics appear once a model mapping is enabled and users get rapid replies."
        action={
          <Button variant="outlined" onClick={onOpenModels} data-testid="rapid-reply-metrics-open-models-btn">
            Review model mappings
          </Button>
        }
      />
    );
  }

  const activeMappings = metrics?.activeMappings ?? metricData.activeMappings ?? 0;

  const columns: DataColumn<ModelMetric>[] = [
    { id: 'mainModel', label: 'Main model', render: row => row.mainModel, sortValue: row => row.mainModel },
    { id: 'rapidModel', label: 'Rapid model', render: row => row.rapidModel, sortValue: row => row.rapidModel },
    {
      id: 'usageCount',
      label: 'Requests',
      numeric: true,
      render: row => row.usageCount.toLocaleString(),
      sortValue: row => row.usageCount,
    },
    {
      id: 'avgLatency',
      label: 'Avg latency (ms)',
      numeric: true,
      render: row => (
        <Stack direction="row" gap={1} alignItems="center" justifyContent="flex-end">
          {row.avgLatency > thresholds.maxLatency && <StatusChip tone="bad" label="Slow" />}
          <span>{Math.round(row.avgLatency).toLocaleString()}</span>
        </Stack>
      ),
      sortValue: row => row.avgLatency,
    },
    {
      id: 'avgTtfvt',
      label: 'Avg TTFVT (ms)',
      numeric: true,
      render: row => (row.avgTtfvt ? Math.round(row.avgTtfvt).toLocaleString() : <Dash />),
      sortValue: row => row.avgTtfvt ?? Number.MAX_SAFE_INTEGER,
    },
    {
      id: 'avgTtfvtSavings',
      label: 'Avg TTFVT savings (ms)',
      numeric: true,
      render: row => (row.avgTtfvtSavings ? Math.round(row.avgTtfvtSavings).toLocaleString() : <Dash />),
      sortValue: row => row.avgTtfvtSavings ?? Number.MIN_SAFE_INTEGER,
    },
    {
      id: 'successRate',
      label: 'Success rate',
      numeric: true,
      render: row => (
        <Stack direction="row" gap={1} alignItems="center" justifyContent="flex-end">
          {row.successRate < thresholds.minSuccessRate && <StatusChip tone="bad" label="Below target" />}
          <span>{row.successRate.toFixed(1)}%</span>
        </Stack>
      ),
      sortValue: row => row.successRate,
    },
  ];

  return (
    <Stack sx={{ gap: 3 }} data-testid="rapid-reply-metrics">
      <StatStrip aria-label="Rapid reply metrics">
        <StatTile
          label="Requests"
          value={metricData.totalRequests}
          comparison={`Across ${activeMappings.toLocaleString()} active mapping${activeMappings === 1 ? '' : 's'}`}
        />
        <StatTile
          label="Success rate"
          value={percent(metricData.successRate) ?? '-'}
          comparison={`Target ${thresholds.minSuccessRate}% or more`}
        />
        <StatTile
          label="Avg latency"
          value={ms(metricData.averageLatency) ?? '-'}
          comparison={`Target ${thresholds.maxLatency.toLocaleString()} ms or less`}
        />
        <StatTile
          label="Avg TTFVT"
          value={ms(metricData.averageTtfvt) ?? '-'}
          comparison="Time to first visible token"
        />
        <StatTile
          label="Avg TTFVT savings"
          value={ms(metricData.averageTtfvtSavings) ?? '-'}
          comparison="Ahead of the main model"
        />
      </StatStrip>

      {modelBreakdown.length > 0 && (
        <Stack sx={{ gap: 2 }}>
          <AdminPageHeader level="section" title="By model" />
          <DataTable
            rows={modelBreakdown}
            columns={columns}
            getRowId={row => `${row.mainModel}::${row.rapidModel}`}
            label="Rapid reply metrics by model"
            onRetry={() => undefined}
            pagination={false}
            minWidth="56rem"
            maxHeight="none"
            testId="rapid-reply-model-breakdown-table"
          />
        </Stack>
      )}
    </Stack>
  );
};
