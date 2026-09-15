import React from 'react';
import { Stack, Grid, Divider, Box, Typography } from '@mui/joy';
import { SearchBox } from './SearchBox';
import { DateFilterComponent } from './DateFilterComponent';
import { MetadataFilterPanel } from './MetadataFilterPanel';
import { useAnalyticsStore } from '../store';
import type { CounterLogRow } from '@client/app/utils/userAPICalls';

interface UserActivityFiltersProps {
  rows?: CounterLogRow[];
}

/**
 * Every control here writes straight to the analytics store, which is the query the server
 * runs. Filtering locally would only ever filter the page currently on screen.
 */
export const UserActivityFilters: React.FC<UserActivityFiltersProps> = ({ rows = [] }) => {
  const {
    dateFilters,
    setDateFilters,
    userActivityFilters,
    setUserActivityFilters,
    metadataFilters,
    setMetadataFilters,
  } = useAnalyticsStore();

  // Suggestions only: the list reflects the current page, and the panel accepts a custom field.
  const metadataFields = React.useMemo(() => {
    const fields = new Set<string>();
    rows.forEach(row => Object.keys(row.metadata || {}).forEach(field => fields.add(field)));
    return Array.from(fields).sort();
  }, [rows]);

  return (
    <Box sx={{ mb: 3 }}>
      <Typography level="title-sm" sx={{ mb: 1, fontWeight: 500 }}>
        Advanced Filters
      </Typography>
      <Stack spacing={2}>
        <DateFilterComponent
          startDate={dateFilters.startDate}
          endDate={dateFilters.endDate}
          onStartDateChange={value => setDateFilters({ ...dateFilters, startDate: value })}
          onEndDateChange={value => setDateFilters({ ...dateFilters, endDate: value })}
        />

        <Divider />

        <Grid container spacing={2}>
          <Grid xs={12} md={6}>
            <SearchBox
              value={userActivityFilters.counterNameSearch}
              onChange={value => setUserActivityFilters({ counterNameSearch: value })}
              placeholder="Search by Counter Name"
            />
          </Grid>
          <Grid xs={12} md={6}>
            <SearchBox
              value={userActivityFilters.userEmailSearch}
              onChange={value => setUserActivityFilters({ userEmailSearch: value })}
              placeholder="Search by User Email"
            />
          </Grid>
        </Grid>

        <Divider />

        <MetadataFilterPanel
          onApplyFilters={setMetadataFilters}
          initialFilters={metadataFilters}
          metadataFields={metadataFields}
        />
      </Stack>
    </Box>
  );
};
