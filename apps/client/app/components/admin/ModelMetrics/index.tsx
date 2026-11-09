import React, { useMemo, useState } from 'react';
import { Button, Stack, Tabs, TabList, Tab, TabPanel } from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import DownloadIcon from '@mui/icons-material/Download';
import dayjs from 'dayjs';

import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { useModelMetrics } from './hooks/useModelMetrics';
import { useSpend } from './hooks/useSpend';
import { useModelMetricsState, ModelMetricsTabValue } from './hooks/useModelMetricsState';
import { exportToCSV } from './utils/csvExport';
import { processChartData } from './utils/chartDataProcessor';
import { MetricsInfoModal } from './components/MetricsInfoModal';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { ControlPanel } from './components/ControlPanel';
import { OverviewTab } from './components/OverviewTab';
import { AnalyticsTab } from './components/AnalyticsTab';
import { RawDataTab } from './components/RawDataTab';
import { SpendTab } from './components/SpendTab';
import { AdminPageHeader, EmptyState, ErrorState, LoadingState, UpdatingBar, useAdminListUrlState } from '../shared';
import { ADMIN_REGION_GAP, adminTabStrip } from '../shared/adminStyles';
import { MODEL_METRICS_SEARCH_KEYS, PERIOD_OPTIONS, resolvePeriod } from './modelMetricsSearch';

// Row cap applied by pages/api/admin/model-metrics.ts (`.limit(500)`); at the cap the count is a floor, not a total.
const SERVER_ROW_CAP = 500;

const ModelMetricsTab: React.FC = () => {
  const [urlState, updateUrlState] = useAdminListUrlState(MODEL_METRICS_SEARCH_KEYS);
  // A user id identifies a person, so this one filter stays out of the URL.
  const [userFilter, setUserFilter] = useState('');
  const { period: urlPeriod = '', model = '', status = '' } = urlState.filters;
  // A period outside the presets (hand-edited URL) is treated as unset.
  const period = PERIOD_OPTIONS.some(option => option.value === urlPeriod) ? urlPeriod : '';

  // Resolved once per pick, not per render: a fresh `now` would change the query key every render.
  const filters = useMemo(
    () => ({
      ...resolvePeriod(period, dayjs()),
      modelFilter: model || undefined,
      statusFilter: status || undefined,
      userFilter: userFilter || undefined,
    }),
    [period, model, status, userFilter]
  );
  const hasFilters = Boolean(period || model || status || userFilter);

  const {
    data: metrics = [],
    isLoading,
    isFetching,
    isPlaceholderData,
    isError,
    refetch,
    recache,
  } = useModelMetrics(filters);
  const { data: modelInfos = [] } = useModelInfo();

  const {
    simplifiedNames,
    setSimplifiedNames,
    activeTab,
    setActiveTab,
    showInfoModal,
    setShowInfoModal,
    sortField,
    sortDirection,
    filteredAndSortedMetrics,
    handleSort,
  } = useModelMetricsState(metrics);

  // Narrowed to the fields the spend query keys on (statusFilter is not applied to
  // spend), so its react-query key stays stable across unrelated filter changes.
  const spendFilters = useMemo(
    () => ({
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      userFilter: filters.userFilter,
      modelFilter: filters.modelFilter,
    }),
    [filters]
  );

  // Owned here (not inside SpendTab) so the shared Refresh button can bust the
  // spend cache too; gated on the active tab to keep the query lazy.
  const {
    data: spendData,
    isLoading: isSpendLoading,
    isError: isSpendError,
    recache: recacheSpend,
  } = useSpend(spendFilters, { enabled: activeTab === 'spend' });

  const handleRefresh = () => {
    // Refresh busts the cache for whichever tab's data is on screen.
    if (activeTab === 'spend') {
      recacheSpend();
    } else {
      recache();
    }
  };

  const handleExportCSV = () => {
    const filename = `model-metrics-${dayjs().format('YYYY-MM-DD-HH-mm-ss')}.csv`;
    exportToCSV(filteredAndSortedMetrics, filename);
  };

  const clearFilters = () => {
    updateUrlState({ filters: { period: '', model: '', status: '' } });
    setUserFilter('');
  };

  const chartData = processChartData(filteredAndSortedMetrics, modelInfos, simplifiedNames);

  // Shown in the panels that read model-metrics rows; Spend and Analytics have their own data.
  const rowsState = (() => {
    if (isError && !metrics.length) {
      return (
        <ErrorState message="Could not load model metrics." onRetry={() => void refetch()} retrying={isFetching} />
      );
    }
    if (!metrics.length) {
      return (
        <EmptyState
          title={hasFilters ? 'No model calls match these filters' : 'No model calls yet'}
          action={
            hasFilters ? (
              <Button variant="outlined" onClick={clearFilters} data-testid="model-metrics-clear-filters-btn">
                Clear filters
              </Button>
            ) : (
              <Button variant="outlined" onClick={handleRefresh} data-testid="model-metrics-empty-refresh-btn">
                Refresh
              </Button>
            )
          }
        />
      );
    }
    return null;
  })();

  return (
    <Stack gap={ADMIN_REGION_GAP}>
      <AdminPageHeader
        title="Model metrics"
        count={isLoading || metrics.length >= SERVER_ROW_CAP ? undefined : metrics.length}
        description="Per-call performance, token use and cost across models."
        actions={
          <>
            <Button
              variant="outlined"
              color="neutral"
              startDecorator={<RefreshIcon />}
              onClick={handleRefresh}
              data-testid="model-metrics-refresh-btn"
            >
              Refresh
            </Button>
            <Button
              variant="outlined"
              color="neutral"
              startDecorator={<DownloadIcon />}
              onClick={handleExportCSV}
              disabled={!filteredAndSortedMetrics.length || isPlaceholderData}
              data-testid="model-metrics-export-btn"
            >
              Export CSV
            </Button>
            <ContextHelpButton helpId="admin/metrics" tooltipText="Model metrics help" />
          </>
        }
      />

      <ControlPanel
        metrics={metrics}
        modelInfos={modelInfos}
        state={urlState}
        onChange={updateUrlState}
        userFilter={userFilter}
        onUserChange={setUserFilter}
        simplifiedNames={simplifiedNames}
        onSimplifiedNamesChange={setSimplifiedNames}
      />

      <UpdatingBar active={isFetching && !isLoading} />

      {isLoading ? (
        <LoadingState label="Loading model metrics" />
      ) : (
        <Tabs value={activeTab} onChange={(_, value) => setActiveTab(value as ModelMetricsTabValue)}>
          <TabList sx={adminTabStrip}>
            <Tab value="overview">Overview</Tab>
            <Tab value="analytics">Analytics</Tab>
            <Tab value="data">Raw data</Tab>
            <Tab value="spend">Spend</Tab>
          </TabList>

          {/* Overview Tab */}
          <TabPanel value="overview" sx={{ p: 1 }}>
            {rowsState ?? <OverviewTab metrics={filteredAndSortedMetrics} chartData={chartData} />}
          </TabPanel>

          {/* Analytics Tab */}
          <TabPanel value="analytics" sx={{ p: 1 }}>
            <AnalyticsTab filters={filters} />
          </TabPanel>

          {/* Raw Data Tab */}
          <TabPanel value="data" sx={{ p: 1 }}>
            {rowsState ?? (
              <RawDataTab
                metrics={filteredAndSortedMetrics}
                modelInfos={modelInfos}
                simplifiedNames={simplifiedNames}
                sortField={sortField}
                sortDirection={sortDirection}
                onSort={handleSort}
                onShowInfoModal={() => setShowInfoModal(true)}
              />
            )}
          </TabPanel>

          {/* Spend Tab */}
          <TabPanel value="spend" sx={{ p: 1 }}>
            <SpendTab data={spendData} isLoading={isSpendLoading} isError={isSpendError} />
          </TabPanel>
        </Tabs>
      )}

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
    </Stack>
  );
};

export default ModelMetricsTab;
