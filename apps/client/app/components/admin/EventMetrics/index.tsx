import React, { useState } from 'react';
import { Box, Typography, LinearProgress, Tabs, TabList, Tab, TabPanel } from '@mui/joy';

import { useEventMetrics } from './hooks/useEventMetrics';
import { useEventMetricsState } from './hooks/useEventMetricsState';
import { processChartData } from './utils/chartDataProcessor';
import { ControlPanel } from './components/ControlPanel';
import { OverviewTab } from './components/OverviewTab';
import { CurationBreakdownTab } from './components/CurationBreakdownTab';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';

const EventMetricsTab: React.FC = () => {
  // Applied filters state (used for API calls)
  const [appliedFilters, setAppliedFilters] = useState<{
    dateFrom?: string;
    dateTo?: string;
    userFilter?: string;
    eventFilter?: string;
    eventCategoryFilter?: string;
  }>({});

  const { data: metrics = [], isLoading, forceRefresh } = useEventMetrics(appliedFilters);

  const {
    // Filter states
    dateFrom,
    dateTo,
    userFilter,
    eventFilter,
    eventCategoryFilter,
    setDateFrom,
    setDateTo,
    setUserFilter,
    setEventFilter,
    setEventCategoryFilter,
    // UI states
    activeTab,
    setActiveTab,
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
      eventCategoryFilter: eventCategoryFilter || undefined,
    });
  };

  const handleClearFilters = () => {
    clearFilters();
    setAppliedFilters({});
  };

  const chartData = processChartData(filteredAndSortedMetrics);

  return (
    <Box sx={{ p: { xs: 1.5, sm: 3 } }}>
      {/* Loading indicator */}
      {isLoading && (
        <Box sx={{ mb: 2 }}>
          <LinearProgress />
          <Typography level="body-sm" sx={{ mt: 1, color: 'text.secondary' }}>
            Loading event metrics...
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
        eventCategoryFilter={eventCategoryFilter}
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
      />

      {/* Tabs Section */}
      <Tabs value={activeTab} onChange={(_, value) => setActiveTab(value as string)}>
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', sm: 'row' },
            justifyContent: 'space-between',
            alignItems: { xs: 'flex-start', sm: 'center' },
            gap: 2,
            mb: 1,
          }}
        >
          <TabList sx={{ overflowX: 'auto', width: { xs: '100%', sm: 'auto' } }}>
            <Tab value="overview" data-testid="overview-tab">
              📊{' '}
              <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
                {' '}
                Overview
              </Box>
            </Tab>
            <Tab value="curation" data-testid="curation-tab">
              📁{' '}
              <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
                {' '}
                Curation Breakdown
              </Box>
            </Tab>
          </TabList>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography level="body-sm" sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}>
              Showing {filteredAndSortedMetrics.length} of {metrics.length} events
            </Typography>
            <ContextHelpButton helpId="admin/metrics" tooltipText="Event Metrics Help" />
          </Box>
        </Box>

        {/* Overview Tab */}
        <TabPanel value="overview" sx={{ p: 1 }}>
          <OverviewTab metrics={filteredAndSortedMetrics} chartData={chartData} />
        </TabPanel>

        {/* Curation Breakdown Tab */}
        <TabPanel value="curation" sx={{ p: 1 }}>
          <CurationBreakdownTab chartData={chartData} />
        </TabPanel>
      </Tabs>
    </Box>
  );
};

export default EventMetricsTab;
