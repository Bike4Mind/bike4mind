import React, { useState } from 'react';
import { Box, Typography, LinearProgress, Tabs, TabList, Tab, TabPanel, Sheet, Table } from '@mui/joy';
import { useRateLimitMetrics } from './hooks/useRateLimitMetrics';
import { useRateLimitMetricsState } from './hooks/useRateLimitMetricsState';
import { processChartData } from './utils/chartDataProcessor';
import { ControlPanel } from './components/ControlPanel';
import { OverviewTab } from './components/OverviewTab';
import type { RateLimitFilters } from './types';

const RateLimitsTab: React.FC = () => {
  const [appliedFilters, setAppliedFilters] = useState<RateLimitFilters>({});

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
  } = useRateLimitMetricsState(snapshots);

  const handleApplyFilters = () => {
    setAppliedFilters({
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      integration: integrationFilter || undefined,
      throttledOnly: throttledOnly || undefined,
    });
  };

  const handleClearFilters = () => {
    clearFilters();
    setAppliedFilters({});
  };

  const chartData = processChartData(filteredSnapshots);

  return (
    <Box sx={{ p: 6 }}>
      {isLoading && (
        <Box sx={{ mb: 2 }}>
          <LinearProgress />
          <Typography level="body-sm" sx={{ mt: 1, color: 'text.secondary' }}>
            Loading rate limit data...
          </Typography>
        </Box>
      )}

      <ControlPanel
        dateFrom={dateFrom}
        dateTo={dateTo}
        integrationFilter={integrationFilter}
        throttledOnly={throttledOnly}
        summaryStats={summaryStats}
        isLoading={isLoading}
        setDateFrom={setDateFrom}
        setDateTo={setDateTo}
        setIntegrationFilter={setIntegrationFilter}
        setThrottledOnly={setThrottledOnly}
        onRefresh={forceRefresh}
        onApplyFilters={handleApplyFilters}
        onClearFilters={handleClearFilters}
      />

      <Tabs defaultValue="overview">
        <TabList>
          <Tab value="overview">Overview</Tab>
          <Tab value="raw">Raw Data</Tab>
        </TabList>

        <TabPanel value="overview" sx={{ p: 1 }}>
          <OverviewTab chartData={chartData} snapshots={filteredSnapshots} />
        </TabPanel>

        <TabPanel value="raw" sx={{ p: 1 }}>
          <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto' }}>
            <Table size="sm" stripe="odd" stickyHeader>
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Integration</th>
                  <th>Endpoint</th>
                  <th>Limit</th>
                  <th>Remaining</th>
                  <th>Usage %</th>
                  <th>Throttled</th>
                  <th>Retry After</th>
                </tr>
              </thead>
              <tbody>
                {filteredSnapshots.map(snap => (
                  <tr key={snap._id}>
                    <td>{new Date(snap.timestamp).toLocaleString()}</td>
                    <td style={{ textTransform: 'capitalize' }}>{snap.integration}</td>
                    <td>
                      <Typography
                        level="body-xs"
                        sx={{ fontFamily: 'monospace', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}
                      >
                        {snap.endpoint}
                      </Typography>
                    </td>
                    <td>{snap.limit ?? '--'}</td>
                    <td>{snap.remaining ?? '--'}</td>
                    <td>{snap.usagePercent !== null ? `${snap.usagePercent}%` : '--'}</td>
                    <td>{snap.wasThrottled ? 'Yes' : 'No'}</td>
                    <td>{snap.retryAfterMs ? `${snap.retryAfterMs}ms` : '--'}</td>
                  </tr>
                ))}
                {filteredSnapshots.length === 0 && (
                  <tr>
                    <td colSpan={8} style={{ textAlign: 'center', padding: '2rem' }}>
                      No data available
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>
          </Sheet>
        </TabPanel>
      </Tabs>
    </Box>
  );
};

export default RateLimitsTab;
