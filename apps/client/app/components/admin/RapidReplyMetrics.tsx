import React, { useState, useMemo } from 'react';
import { Card, CardContent, Typography, Stack, Grid, Alert, Sheet, Table, Chip, IconButton } from '@mui/joy';
import { KeyboardArrowUp, KeyboardArrowDown } from '@mui/icons-material';

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

interface RapidReplyMetricsProps {
  metrics?: {
    metrics?: MetricData;
    activeMappings?: number;
    modelBreakdown?: ModelMetric[];
  } | null;
  thresholds?: {
    maxLatency: number;
    minSuccessRate: number;
  };
}

type SortField =
  | 'mainModel'
  | 'rapidModel'
  | 'usageCount'
  | 'avgLatency'
  | 'avgTtfvtSavings'
  | 'avgTtfvt'
  | 'successRate';
type SortDirection = 'asc' | 'desc';

// Module-level component for sortable table headers
const SortableHeader = ({
  field,
  children,
  onSort,
  currentSortField,
  currentSortDirection,
}: {
  field: SortField;
  children: React.ReactNode;
  onSort: (field: SortField) => void;
  currentSortField: SortField;
  currentSortDirection: 'asc' | 'desc';
}) => (
  <th>
    <Stack direction="row" alignItems="center" spacing={1} sx={{ cursor: 'pointer' }} onClick={() => onSort(field)}>
      <Typography level="body-sm" fontWeight="md">
        {children}
      </Typography>
      {currentSortField === field && (
        <IconButton size="sm" variant="plain" color="neutral">
          {currentSortDirection === 'asc' ? (
            <KeyboardArrowUp fontSize="small" />
          ) : (
            <KeyboardArrowDown fontSize="small" />
          )}
        </IconButton>
      )}
    </Stack>
  </th>
);

export const RapidReplyMetrics: React.FC<RapidReplyMetricsProps> = ({ metrics, thresholds }) => {
  const [sortField, setSortField] = useState<SortField>('avgLatency');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc'); // Default to lowest latency first

  const { metrics: metricData, activeMappings, modelBreakdown } = metrics || {};

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const sortedModelBreakdown = useMemo(() => {
    if (!modelBreakdown) return [];

    return [...modelBreakdown].sort((a, b) => {
      let aValue: any = a[sortField];
      let bValue: any = b[sortField];

      if (typeof aValue === 'string') {
        aValue = aValue.toLowerCase();
        bValue = bValue.toLowerCase();
      }

      // Handle null values for TTFVT - put them at the end
      if (aValue === null && bValue === null) return 0;
      if (aValue === null) return 1;
      if (bValue === null) return -1;

      if (sortDirection === 'asc') {
        return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
      } else {
        return aValue > bValue ? -1 : aValue < bValue ? 1 : 0;
      }
    });
  }, [modelBreakdown, sortField, sortDirection]);

  if (!metrics) {
    return (
      <Grid xs={12}>
        <Alert color="neutral" data-testid="no-metrics-alert">
          <Typography>No metrics data available yet. Metrics will appear once rapid replies are being used.</Typography>
        </Alert>
      </Grid>
    );
  }

  return (
    <Grid container spacing={3}>
      {/* Summary Cards */}
      <Grid xs={12} md={2}>
        <Card data-testid="total-requests-card" sx={{ height: '100%' }}>
          <CardContent>
            <Stack style={{ justifyContent: 'space-between', height: '100%' }}>
              <Typography level="body-sm" textColor="text.secondary">
                Total Requests
              </Typography>
              <Typography level="h3">{metricData?.totalRequests?.toLocaleString() || 0}</Typography>
            </Stack>
          </CardContent>
        </Card>
      </Grid>

      <Grid xs={12} md={2}>
        <Card data-testid="success-rate-card" sx={{ height: '100%' }}>
          <CardContent>
            <Stack style={{ justifyContent: 'space-between', height: '100%' }}>
              <Typography level="body-sm" textColor="text.secondary">
                Success Rate
              </Typography>
              <Typography
                level="h3"
                color={
                  metricData?.successRate && metricData.successRate >= (thresholds?.minSuccessRate || 90)
                    ? 'success'
                    : 'danger'
                }
              >
                {metricData?.successRate?.toFixed(1) || 0}%
              </Typography>
            </Stack>
          </CardContent>
        </Card>
      </Grid>

      <Grid xs={12} md={2}>
        <Card data-testid="avg-latency-card" sx={{ height: '100%' }}>
          <CardContent>
            <Stack style={{ justifyContent: 'space-between', height: '100%' }}>
              <Typography level="body-sm" textColor="text.secondary">
                Avg Latency
              </Typography>
              {/* helper text */}
              <Typography level="body-xs" textColor="text.secondary">
                How long it takes for the rapid reply to be generated
              </Typography>

              <Typography
                level="h3"
                color={
                  metricData?.averageLatency && metricData.averageLatency <= (thresholds?.maxLatency || 2000)
                    ? 'success'
                    : 'danger'
                }
              >
                {metricData?.averageLatency?.toFixed(0) || 0}ms
              </Typography>
            </Stack>
          </CardContent>
        </Card>
      </Grid>

      <Grid xs={12} md={2}>
        <Card data-testid="avg-ttfvt-card" sx={{ height: '100%' }}>
          <CardContent>
            <Stack style={{ justifyContent: 'space-between', height: '100%' }}>
              <Typography level="body-sm" textColor="text.secondary">
                Avg TTFVT
              </Typography>
              <Typography level="body-xs" textColor="text.secondary">
                How long it takes for the first token to be received
              </Typography>
              <Typography level="h3">
                {metricData?.averageTtfvt ? `${metricData.averageTtfvt.toFixed(0)}ms` : 'N/A'}
              </Typography>
            </Stack>
          </CardContent>
        </Card>
      </Grid>

      <Grid xs={12} md={2}>
        <Card data-testid="avg-ttfvt-savings-card" sx={{ height: '100%' }}>
          <CardContent>
            <Stack style={{ justifyContent: 'space-between', height: '100%' }}>
              <Typography level="body-sm" textColor="text.secondary">
                Avg TTFVT Savings
              </Typography>
              <Typography level="body-xs" textColor="text.secondary">
                How much faster rapid reply is vs main completion
              </Typography>
              <Typography level="h3">
                {metricData?.averageTtfvtSavings ? `${metricData.averageTtfvtSavings.toFixed(0)}ms` : 'N/A'}
              </Typography>
            </Stack>
          </CardContent>
        </Card>
      </Grid>

      <Grid xs={12} md={2}>
        <Card data-testid="active-mappings-card" sx={{ height: '100%' }}>
          <CardContent>
            <Stack style={{ justifyContent: 'space-between', height: '100%' }}>
              <Typography level="body-sm" textColor="text.secondary">
                Active Mappings
              </Typography>
              <Typography level="body-xs" textColor="text.secondary">
                Number of enabled model mappings
              </Typography>
              <Typography level="h3">{activeMappings || 0}</Typography>
            </Stack>
          </CardContent>
        </Card>
      </Grid>

      {/* Model Performance Breakdown */}
      {modelBreakdown && modelBreakdown.length > 0 && (
        <Grid xs={12}>
          <Card data-testid="model-breakdown-card">
            <CardContent>
              <Typography level="title-lg" sx={{ mb: 2 }}>
                Model Performance Breakdown
              </Typography>
              <Sheet variant="outlined" sx={{ borderRadius: 'sm' }}>
                <Table data-testid="model-breakdown-table" hoverRow>
                  <thead>
                    <tr>
                      <SortableHeader
                        field="mainModel"
                        onSort={handleSort}
                        currentSortField={sortField}
                        currentSortDirection={sortDirection}
                      >
                        Main Model
                      </SortableHeader>
                      <SortableHeader
                        field="rapidModel"
                        onSort={handleSort}
                        currentSortField={sortField}
                        currentSortDirection={sortDirection}
                      >
                        Rapid Model
                      </SortableHeader>
                      <SortableHeader
                        field="usageCount"
                        onSort={handleSort}
                        currentSortField={sortField}
                        currentSortDirection={sortDirection}
                      >
                        Requests
                      </SortableHeader>
                      <SortableHeader
                        field="avgLatency"
                        onSort={handleSort}
                        currentSortField={sortField}
                        currentSortDirection={sortDirection}
                      >
                        Avg Latency
                      </SortableHeader>
                      <SortableHeader
                        field="avgTtfvtSavings"
                        onSort={handleSort}
                        currentSortField={sortField}
                        currentSortDirection={sortDirection}
                      >
                        Avg TTFVT Savings
                      </SortableHeader>
                      <SortableHeader
                        field="avgTtfvt"
                        onSort={handleSort}
                        currentSortField={sortField}
                        currentSortDirection={sortDirection}
                      >
                        Avg TTFVT
                      </SortableHeader>
                      <SortableHeader
                        field="successRate"
                        onSort={handleSort}
                        currentSortField={sortField}
                        currentSortDirection={sortDirection}
                      >
                        Success Rate
                      </SortableHeader>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedModelBreakdown.map((model, index) => (
                      <tr key={`breakdown-${model.mainModel}-${model.rapidModel}-${index}`}>
                        <td>
                          <Typography level="body-sm" fontWeight="md">
                            {model.mainModel}
                          </Typography>
                        </td>
                        <td>
                          <Typography level="body-sm" textColor="text.secondary">
                            {model.rapidModel}
                          </Typography>
                        </td>
                        <td>{model.usageCount.toLocaleString()}</td>
                        <td>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Typography level="body-sm">{model.avgLatency.toFixed(0)}ms</Typography>
                            <Chip
                              size="sm"
                              color={model.avgLatency <= (thresholds?.maxLatency || 2000) ? 'success' : 'danger'}
                              variant="outlined"
                            >
                              {model.avgLatency <= (thresholds?.maxLatency || 2000) ? 'Fast' : 'Slow'}
                            </Chip>
                          </Stack>
                        </td>
                        <td>
                          <Typography level="body-sm">
                            {model.avgTtfvtSavings ? `${model.avgTtfvtSavings.toFixed(0)}ms` : 'N/A'}
                          </Typography>
                        </td>
                        <td>
                          <Typography level="body-sm">
                            {model.avgTtfvt ? `${model.avgTtfvt.toFixed(0)}ms` : 'N/A'}
                          </Typography>
                        </td>
                        <td>
                          <Chip
                            size="sm"
                            color={model.successRate >= (thresholds?.minSuccessRate || 90) ? 'success' : 'danger'}
                            variant="soft"
                          >
                            {model.successRate.toFixed(1)}%
                          </Chip>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Sheet>
            </CardContent>
          </Card>
        </Grid>
      )}
    </Grid>
  );
};
