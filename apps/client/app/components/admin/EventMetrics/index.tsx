import React, { useState, type ReactNode } from 'react';
import { Button, Stack, Tab, TabList, TabPanel, Tabs } from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';

import { useEventMetrics, type MetricsFilters } from './hooks/useEventMetrics';
import { useApplyPickedFilters, useEventMetricsState } from './hooks/useEventMetricsState';
import { processChartData } from './utils/chartDataProcessor';
import { ControlPanel } from './components/ControlPanel';
import { EventMetricsStats } from './components/EventMetricsStats';
import { OverviewTab } from './components/OverviewTab';
import { CurationBreakdownTab } from './components/CurationBreakdownTab';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { AdminPageHeader, ErrorState, LoadingState, SegmentedControl, useAdminListUrlState } from '../shared';
import { ADMIN_REGION_GAP, adminTabStrip } from '../shared/adminStyles';
import { EVENTS_SEARCH_KEYS, EVENTS_VIEW_BY_USER } from './eventsTabSearch';
import { UserActivityView } from './UserActivity';

/** Both views share the page header; the events view adds its Refresh action. */
const EventMetricsHeader: React.FC<{ actions?: ReactNode }> = ({ actions }) => (
  <AdminPageHeader
    title="Event metrics"
    description="Recorded product events by date, category, event and user."
    actions={
      <>
        {actions}
        <ContextHelpButton helpId="admin/metrics" tooltipText="Event metrics help" />
      </>
    }
  />
);

const EventMetricsPanel: React.FC<{ viewSwitch: ReactNode }> = ({ viewSwitch }) => {
  const [appliedFilters, setAppliedFilters] = useState<MetricsFilters>({});

  const { data: metrics = [], isLoading, isFetching, isError, error, forceRefresh } = useEventMetrics(appliedFilters);

  const {
    dateRange,
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
    activeTab,
    setActiveTab,
    filteredAndSortedMetrics,
    clearFilters,
    setDateRange,
  } = useEventMetricsState(metrics);

  useApplyPickedFilters({ dateFrom, dateTo, userFilter, eventFilter, eventCategoryFilter }, setAppliedFilters);

  const handleRefresh = () => {
    forceRefresh();
  };

  const chartData = processChartData(filteredAndSortedMetrics);
  const errorState = isError && (
    <ErrorState
      message={`Event metrics failed to load. ${error instanceof Error ? error.message : ''}`.trim()}
      onRetry={handleRefresh}
      retrying={isFetching}
    />
  );

  let body: ReactNode;
  if (isLoading) body = <LoadingState label="Loading event metrics" />;
  else if (isError && metrics.length === 0) body = errorState;
  else
    body = (
      <>
        {errorState}
        <EventMetricsStats metrics={metrics} filteredMetrics={filteredAndSortedMetrics} />
        <Tabs value={activeTab} onChange={(_, value) => setActiveTab(value as string)}>
          <TabList sx={adminTabStrip}>
            <Tab value="overview" data-testid="overview-tab">
              Overview
            </Tab>
            <Tab value="curation" data-testid="curation-tab">
              Curation breakdown
            </Tab>
          </TabList>
          <TabPanel value="overview" sx={{ p: 0, pt: 2 }}>
            <OverviewTab chartData={chartData} />
          </TabPanel>
          <TabPanel value="curation" sx={{ p: 0, pt: 2 }}>
            <CurationBreakdownTab
              chartData={chartData}
              emptyAction={
                <Button variant="outlined" onClick={handleRefresh} data-testid="event-metrics-curation-refresh-btn">
                  Refresh metrics
                </Button>
              }
            />
          </TabPanel>
        </Tabs>
      </>
    );

  return (
    <Stack gap={ADMIN_REGION_GAP}>
      <EventMetricsHeader
        actions={
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            startDecorator={<RefreshIcon />}
            loading={isFetching}
            onClick={handleRefresh}
            data-testid="event-metrics-refresh-btn"
          >
            Refresh
          </Button>
        }
      />
      {viewSwitch}
      <ControlPanel
        metrics={metrics}
        dateRange={dateRange}
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
        onClearFilters={clearFilters}
        onSetDateRange={setDateRange}
      />
      {body}
    </Stack>
  );
};

const VIEW_OPTIONS = [
  { value: 'events', label: 'Events' },
  { value: EVENTS_VIEW_BY_USER, label: 'By user' },
] as const;

const EventMetricsTab: React.FC = () => {
  const [state, update] = useAdminListUrlState(EVENTS_SEARCH_KEYS);
  const view = state.filters.view === EVENTS_VIEW_BY_USER ? EVENTS_VIEW_BY_USER : 'events';

  const viewSwitch = (
    <SegmentedControl
      options={VIEW_OPTIONS}
      value={view}
      onChange={next => update({ filters: { view: next === 'events' ? '' : next } })}
      aria-label="Events view"
      data-testid="event-metrics-view"
    />
  );

  if (view === 'events') return <EventMetricsPanel viewSwitch={viewSwitch} />;
  return (
    <Stack gap={ADMIN_REGION_GAP}>
      <EventMetricsHeader />
      {viewSwitch}
      <UserActivityView />
    </Stack>
  );
};

export default EventMetricsTab;
