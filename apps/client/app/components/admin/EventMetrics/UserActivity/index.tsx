import React, { useEffect } from 'react';
import { Box, LinearProgress } from '@mui/joy';
import { UserActivityTab } from './UserActivityTab';
import { useUserActivityData } from './useUserActivityData';
import { useAnalyticsStore } from './store';

/** Overview > Events, "By user": the paged CounterLog grid per day, action and user. */
export function UserActivityView() {
  const refreshDefaultDateFilters = useAnalyticsStore(state => state.refreshDefaultDateFilters);

  useEffect(() => {
    refreshDefaultDateFilters();
  }, [refreshDefaultDateFilters]);

  const { data, isLoading, isFetching, error, refetch } = useUserActivityData();

  return (
    <Box data-testid="user-activity-view" sx={{ width: '100%' }}>
      {/* Reserved height keeps the bar from shifting the content below it on every page turn. */}
      <Box data-testid="user-activity-progress-slot" sx={{ width: '100%', height: 4, mb: 1 }}>
        {isFetching && <LinearProgress size="sm" sx={{ width: '100%' }} />}
      </Box>
      {!isLoading && (
        <UserActivityTab
          rows={data?.logs || []}
          total={data?.total || 0}
          isFetching={isFetching}
          error={error}
          onRefresh={() => void refetch()}
        />
      )}
    </Box>
  );
}
