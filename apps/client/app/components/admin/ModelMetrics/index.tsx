import React, { useState } from 'react';
import { Box, Typography, LinearProgress, Tabs, TabList, Tab, TabPanel } from '@mui/joy';
import dayjs from 'dayjs';

import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { useModelMetrics } from './hooks/useModelMetrics';
import { useModelMetricsState } from './hooks/useModelMetricsState';
import { exportToCSV } from './utils/csvExport';
import { processChartData } from './utils/chartDataProcessor';
import { MetricsInfoModal } from './components/MetricsInfoModal';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { ControlPanel } from './components/ControlPanel';
import { OverviewTab } from './components/OverviewTab';
import { AnalyticsTab } from './components/AnalyticsTab';
import { RawDataTab } from './components/RawDataTab';

const ModelMetricsTab: React.FC = () => {
  // Applied filters state (used for API calls)
  const [appliedFilters, setAppliedFilters] = useState<{
    dateFrom?: string;
    dateTo?: string;
    userFilter?: string;
    modelFilter?: string;
    statusFilter?: string;
  }>({});

  const { data: metrics = [], isLoading, recache } = useModelMetrics(appliedFilters);
  const { data: modelInfos = [] } = useModelInfo();

  const {
    // Filter states
    dateFrom,
    dateTo,
    userFilter,
    modelFilter,
    statusFilter,
    setDateFrom,
    setDateTo,
    setUserFilter,
    setModelFilter,
    setStatusFilter,
    // UI states
    simplifiedNames,
    setSimplifiedNames,
    activeTab,
    setActiveTab,
    showInfoModal,
    setShowInfoModal,
    // Sort states
    sortField,
    sortDirection,
    // Computed data
    filteredAndSortedMetrics,
    // Helper functions
    handleSort,
    clearFilters,
    setDateRange,
  } = useModelMetricsState(metrics);

  const handleRefresh = () => {
    recache();
  };

  const handleExportCSV = () => {
    const filename = `model-metrics-${dayjs().format('YYYY-MM-DD-HH-mm-ss')}.csv`;
    exportToCSV(filteredAndSortedMetrics, filename);
  };

  const handleApplyFilters = () => {
    setAppliedFilters({
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      userFilter: userFilter || undefined,
      modelFilter: modelFilter || undefined,
      statusFilter: statusFilter || undefined,
    });
  };

  const handleClearFilters = () => {
    clearFilters();
    setAppliedFilters({});
  };

  const chartData = processChartData(filteredAndSortedMetrics, modelInfos, simplifiedNames);

  if (isLoading) {
    return (
      <Box sx={{ p: 2 }}>
        <LinearProgress />
        <Typography sx={{ mt: 2 }}>Loading model metrics...</Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ p: { xs: 0, sm: 2 } }}>
      {/* Control Panel */}
      <ControlPanel
        metrics={metrics}
        filteredMetrics={filteredAndSortedMetrics}
        modelInfos={modelInfos}
        dateFrom={dateFrom}
        dateTo={dateTo}
        userFilter={userFilter}
        modelFilter={modelFilter}
        statusFilter={statusFilter}
        simplifiedNames={simplifiedNames}
        setDateFrom={setDateFrom}
        setDateTo={setDateTo}
        setUserFilter={setUserFilter}
        setModelFilter={setModelFilter}
        setStatusFilter={setStatusFilter}
        setSimplifiedNames={setSimplifiedNames}
        onRefresh={handleRefresh}
        onExportCSV={handleExportCSV}
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
          <TabList sx={{ overflowX: 'auto', width: { xs: '100%', sm: 'auto' }, px: { xs: 1, sm: 0 } }}>
            <Tab value="overview">
              📊{' '}
              <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
                {' '}
                Overview
              </Box>
            </Tab>
            <Tab value="analytics">
              📈{' '}
              <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
                {' '}
                Analytics
              </Box>
            </Tab>
            <Tab value="data">
              📋{' '}
              <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
                {' '}
                Raw Data
              </Box>
            </Tab>
          </TabList>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: { xs: 1, sm: 0 } }}>
            <Typography level="body-sm" sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}>
              Showing {filteredAndSortedMetrics.length} of {metrics.length} records
            </Typography>
            <ContextHelpButton helpId="admin/metrics" tooltipText="Model Metrics Help" />
          </Box>
        </Box>

        {/* Overview Tab */}
        <TabPanel value="overview" sx={{ p: 1 }}>
          <OverviewTab metrics={filteredAndSortedMetrics} chartData={chartData} />
        </TabPanel>

        {/* Analytics Tab */}
        <TabPanel value="analytics" sx={{ p: 1 }}>
          <AnalyticsTab chartData={chartData} filters={appliedFilters} />
        </TabPanel>

        {/* Raw Data Tab */}
        <TabPanel value="data" sx={{ p: 1 }}>
          <RawDataTab
            metrics={filteredAndSortedMetrics}
            modelInfos={modelInfos}
            simplifiedNames={simplifiedNames}
            sortField={sortField}
            sortDirection={sortDirection}
            onSort={handleSort}
            onShowInfoModal={() => setShowInfoModal(true)}
          />
        </TabPanel>
      </Tabs>

      {/* Performance Metrics Info Modal */}
      <MetricsInfoModal
        open={showInfoModal}
        onClose={() => setShowInfoModal(false)}
        hasStreamingData={filteredAndSortedMetrics.some(
          metric =>
            metric.performance?.streamingPerformance &&
            ((metric.performance.streamingPerformance.chunkCount ?? 0) > 0 ||
              (metric.performance.streamingPerformance.totalStreamTime ?? 0) > 0)
        )}
      />
    </Box>
  );
};

export default ModelMetricsTab;
