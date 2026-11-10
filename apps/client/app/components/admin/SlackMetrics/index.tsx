import React, { useState, type ReactNode } from 'react';
import { Button, Stack } from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';

import { useEventMetrics, type MetricsFilters } from '../EventMetrics/hooks/useEventMetrics';
import { useApplyPickedFilters, useEventMetricsState } from '../EventMetrics/hooks/useEventMetricsState';
import { processChartData } from '../EventMetrics/utils/chartDataProcessor';
import { ControlPanel } from '../EventMetrics/components/ControlPanel';
import { EventMetricsStats } from '../EventMetrics/components/EventMetricsStats';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { AdminPageHeader, ErrorState, LoadingState, UpdatingBar } from '../shared';
import { ADMIN_REGION_GAP } from '../shared/adminStyles';
import { SlackMetricsTab } from './SlackMetricsTab';

// Every request is scoped to Slack events; the category filter is hidden on this page.
const SLACK_CATEGORY = 'Slack';

const SlackMetricsPage: React.FC = () => {
  const [appliedFilters, setAppliedFilters] = useState<MetricsFilters>({ eventCategoryFilter: SLACK_CATEGORY });

  const { data: metrics = [], isLoading, isFetching, isError, error, forceRefresh } = useEventMetrics(appliedFilters);

  const {
    dateRange,
    dateFrom,
    dateTo,
    userFilter,
    eventFilter,
    setDateFrom,
    setDateTo,
    setUserFilter,
    setEventFilter,
    setEventCategoryFilter,
    filteredAndSortedMetrics,
    hasFilters,
    clearFilters,
    setDateRange,
  } = useEventMetricsState(metrics);

  useApplyPickedFilters(
    { dateFrom, dateTo, userFilter, eventFilter, eventCategoryFilter: SLACK_CATEGORY },
    setAppliedFilters
  );

  const handleRefresh = () => {
    forceRefresh();
  };

  const chartData = processChartData(filteredAndSortedMetrics);
  const errorState = isError && (
    <ErrorState
      message={`Slack metrics failed to load. ${error instanceof Error ? error.message : ''}`.trim()}
      onRetry={handleRefresh}
      retrying={isFetching}
    />
  );

  const emptyAction = hasFilters ? (
    <Button variant="outlined" onClick={clearFilters} data-testid="slack-metrics-empty-clear-filters-btn">
      Clear filters
    </Button>
  ) : (
    <Button variant="outlined" onClick={handleRefresh} data-testid="slack-metrics-empty-refresh-btn">
      Refresh metrics
    </Button>
  );

  // LoadingState only on a first load: a filter change keeps the previous metrics (placeholder data)
  // and refetches under the UpdatingBar.
  let body: ReactNode;
  if (isLoading) body = <LoadingState label="Loading Slack metrics" />;
  else if (isError && metrics.length === 0) body = errorState;
  else
    body = (
      <Stack gap={ADMIN_REGION_GAP} sx={{ position: 'relative' }}>
        <UpdatingBar active={isFetching} testId="slack-metrics-updating" placement="overlay" />
        {errorState}
        <EventMetricsStats metrics={metrics} filteredMetrics={filteredAndSortedMetrics} />
        <SlackMetricsTab chartData={chartData} filtered={hasFilters} emptyAction={emptyAction} />
      </Stack>
    );

  return (
    <Stack gap={ADMIN_REGION_GAP}>
      <AdminPageHeader
        title="Slack metrics"
        description="Usage of the Slack integration: events, agents, intents and exports."
        actions={
          <>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              startDecorator={<RefreshIcon />}
              loading={isFetching}
              onClick={handleRefresh}
              data-testid="slack-metrics-refresh-btn"
            >
              Refresh
            </Button>
            <ContextHelpButton helpId="admin/metrics" tooltipText="Slack metrics help" />
          </>
        }
      />
      <ControlPanel
        metrics={metrics}
        dateRange={dateRange}
        dateFrom={dateFrom}
        dateTo={dateTo}
        userFilter={userFilter}
        eventFilter={eventFilter}
        eventCategoryFilter={SLACK_CATEGORY}
        setDateFrom={setDateFrom}
        setDateTo={setDateTo}
        setUserFilter={setUserFilter}
        setEventFilter={setEventFilter}
        setEventCategoryFilter={setEventCategoryFilter}
        onClearFilters={clearFilters}
        onSetDateRange={setDateRange}
        hasFilters={hasFilters}
        hideCategoryFilter
      />
      {body}
    </Stack>
  );
};

export default SlackMetricsPage;
