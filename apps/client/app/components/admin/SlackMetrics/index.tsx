import React, { useState } from 'react';
import { Box, Typography, LinearProgress, Alert, Button } from '@mui/joy';
import { Warning } from '@mui/icons-material';

import { useEventMetrics } from '../EventMetrics/hooks/useEventMetrics';
import { useEventMetricsState } from '../EventMetrics/hooks/useEventMetricsState';
import { processChartData } from '../EventMetrics/utils/chartDataProcessor';
import { ControlPanel } from '../EventMetrics/components/ControlPanel';
import { SlackMetricsTab } from './SlackMetricsTab';

const SlackMetricsPage: React.FC = () => {
  // Applied filters state (used for API calls)
  const [appliedFilters, setAppliedFilters] = useState<{
    dateFrom?: string;
    dateTo?: string;
    userFilter?: string;
    eventFilter?: string;
    eventCategoryFilter?: string;
  }>({
    eventCategoryFilter: 'Slack',
  });

  // Always force Slack category filter in API calls
  const filtersForApi = {
    ...appliedFilters,
    eventCategoryFilter: 'Slack',
  };

  const { data: metrics = [], isLoading, isError, error, forceRefresh } = useEventMetrics(filtersForApi);

  const {
    // Filter states
    dateFrom,
    dateTo,
    userFilter,
    eventFilter,
    // eventCategoryFilter, // Ignored in UI since we hide the selector
    setDateFrom,
    setDateTo,
    setUserFilter,
    setEventFilter,
    setEventCategoryFilter,
    // Computed data
    filteredAndSortedMetrics,
    // Helper functions
    clearFilters,
    setDateRange,
  } = useEventMetricsState(metrics);

  const handleRefresh = () => {
    forceRefresh();
  };

  const handleApplyFilters = () => {
    setAppliedFilters({
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      userFilter: userFilter || undefined,
      eventFilter: eventFilter || undefined,
      eventCategoryFilter: 'Slack',
    });
  };

  const handleClearFilters = () => {
    clearFilters();
    setAppliedFilters({
      eventCategoryFilter: 'Slack',
    });
  };

  const chartData = processChartData(filteredAndSortedMetrics);

  return (
    <Box sx={{ p: { xs: 1.5, sm: 3 } }}>
      <Box sx={{ mb: 4 }}>
        <Typography level="h2">Slack Metrics</Typography>
        <Typography level="body-md" color="neutral">
          Analytics and insights for Slack integration usage.
        </Typography>
      </Box>

      {/* Error State */}
      {isError && (
        <Alert
          color="danger"
          variant="soft"
          startDecorator={<Warning />}
          endDecorator={
            <Button variant="soft" color="danger" size="sm" onClick={handleRefresh}>
              Retry
            </Button>
          }
          sx={{ mb: 2 }}
        >
          <Box>
            <Typography level="title-sm">Failed to load metrics</Typography>
            <Typography level="body-sm">{error instanceof Error ? error.message : 'Unknown error'}</Typography>
          </Box>
        </Alert>
      )}

      {/* Loading indicator */}
      {isLoading && (
        <Box sx={{ mb: 2 }}>
          <LinearProgress />
          <Typography level="body-sm" sx={{ mt: 1, color: 'text.secondary' }}>
            Loading metrics...
          </Typography>
        </Box>
      )}

      {/* Control Panel */}
      <ControlPanel
        metrics={metrics}
        filteredMetrics={filteredAndSortedMetrics}
        dateFrom={dateFrom}
        dateTo={dateTo}
        userFilter={userFilter}
        eventFilter={eventFilter}
        eventCategoryFilter="Slack" // Display as Slack (though hidden)
        setDateFrom={setDateFrom}
        setDateTo={setDateTo}
        setUserFilter={setUserFilter}
        setEventFilter={setEventFilter}
        setEventCategoryFilter={setEventCategoryFilter}
        onRefresh={handleRefresh}
        onClearFilters={handleClearFilters}
        onSetDateRange={setDateRange}
        onApplyFilters={handleApplyFilters}
        isLoading={isLoading}
        hideCategoryFilter={true}
      />

      <Box sx={{ mt: 2 }}>
        <SlackMetricsTab chartData={chartData} />
      </Box>
    </Box>
  );
};

export default SlackMetricsPage;
