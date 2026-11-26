import React, { useMemo } from 'react';
import { Button, Tabs, TabList, Tab, TabPanel, Stack } from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import { AdminPageHeader, DataTable, EmptyState, LoadingState, StatStrip, StatTile } from '../shared';
import { snapshotColumns } from './snapshotColumns';
import { ADMIN_REGION_GAP } from '../shared/adminStyles';
import { useRateLimitMetrics } from './hooks/useRateLimitMetrics';
import { useRateLimitMetricsState } from './hooks/useRateLimitMetricsState';
import { processChartData } from './utils/chartDataProcessor';
import { ControlPanel } from './components/ControlPanel';
import { OverviewTab } from './components/OverviewTab';
import { useRateLimitsSearchParams } from './hooks/useRateLimitsSearchParams';
import { RATE_LIMIT_INTEGRATIONS } from '@bike4mind/common';
import { oneOf } from '../adminSearchValues';
import { DEFAULT_RATE_LIMITS_VIEW, RATE_LIMITS_VIEWS, parseIsoDateTime } from './rateLimitsSearch';
import type { RateLimitFilters } from './types';

const parseDraftIntegration = oneOf(RATE_LIMIT_INTEGRATIONS);
const parseView = oneOf(RATE_LIMITS_VIEWS);

const RateLimitsTab: React.FC = () => {
  const applied = useRateLimitsSearchParams();
  const appliedFilters: RateLimitFilters = {
    dateFrom: applied.dateFrom || undefined,
    dateTo: applied.dateTo || undefined,
    integration: applied.integration || undefined,
    throttledOnly: applied.throttledOnly || undefined,
  };

  const { data: snapshots, isLoading, forceRefresh } = useRateLimitMetrics(appliedFilters);

  const {
    dateFrom,
    dateTo,
    integrationFilter,
    throttledOnly,
    setDateFrom,
    setDateTo,
    setIntegrationFilter,
    setThrottledOnly,
    filteredSnapshots,
    summaryStats,
    clearFilters,
  } = useRateLimitMetricsState(snapshots, applied);

  const handleApplyFilters = () => {
    applied.patch({
      dateFrom: parseIsoDateTime(dateFrom) ?? '',
      dateTo: parseIsoDateTime(dateTo) ?? '',
      integration: parseDraftIntegration(integrationFilter) ?? '',
      throttledOnly,
    });
  };

  const handleClearFilters = () => {
    clearFilters();
    applied.patch({ dateFrom: '', dateTo: '', integration: '', throttledOnly: false });
  };

  const chartData = useMemo(() => processChartData(filteredSnapshots), [filteredSnapshots]);

  const clearFiltersAction = (
    <Button size="sm" variant="outlined" onClick={handleClearFilters} data-testid="rate-limit-empty-clear-btn">
      Clear filters
    </Button>
  );

  return (
    <Stack sx={{ gap: ADMIN_REGION_GAP, minWidth: 0 }} data-testid="admin-rate-limits-tab">
      <AdminPageHeader
        title="Rate limits"
        description="Rate limit snapshots from third-party integrations, recorded on each MCP tool call."
        actions={
          <Button
            data-testid="rate-limit-refresh-btn"
            size="sm"
            variant="outlined"
            startDecorator={<RefreshIcon />}
            onClick={forceRefresh}
          >
            Refresh
          </Button>
        }
      />

      <StatStrip>
        <StatTile label="Snapshots" value={summaryStats.total} />
        <StatTile label="Throttled" value={summaryStats.throttled} />
        <StatTile label="Average usage" value={`${summaryStats.avgUsage}%`} />
      </StatStrip>

      <ControlPanel
        dateFrom={dateFrom}
        dateTo={dateTo}
        integrationFilter={integrationFilter}
        throttledOnly={throttledOnly}
        isLoading={isLoading}
        setDateFrom={setDateFrom}
        setDateTo={setDateTo}
        setIntegrationFilter={setIntegrationFilter}
        setThrottledOnly={setThrottledOnly}
        onApplyFilters={handleApplyFilters}
        onClearFilters={handleClearFilters}
      />

      {isLoading ? (
        <LoadingState label="Loading rate limit data" testId="rate-limit-loading" />
      ) : (
        <Tabs
          value={applied.view}
          onChange={(_, value) => applied.patch({ view: parseView(value) ?? DEFAULT_RATE_LIMITS_VIEW })}
          sx={{ bgcolor: 'transparent' }}
        >
          <TabList>
            <Tab value="overview">Overview</Tab>
            <Tab value="raw">Raw data</Tab>
          </TabList>

          <TabPanel value="overview" sx={{ px: 0, pt: 2 }}>
            <OverviewTab chartData={chartData} snapshots={filteredSnapshots} emptyAction={clearFiltersAction} />
          </TabPanel>

          <TabPanel value="raw" sx={{ px: 0, pt: 2 }}>
            <DataTable
              rows={filteredSnapshots}
              columns={snapshotColumns}
              getRowId={snap => snap._id}
              label="Rate limit snapshots"
              onRetry={() => void forceRefresh()}
              empty={<EmptyState title="No rate limit data" action={clearFiltersAction} />}
              testId="rate-limit-raw-table"
              stripe="odd"
              pagination={false}
              minWidth="65.5rem"
            />
          </TabPanel>
        </Tabs>
      )}
    </Stack>
  );
};

export default RateLimitsTab;
