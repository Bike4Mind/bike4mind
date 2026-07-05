import React from 'react';
import { Stack, Grid, Divider, Box, Typography } from '@mui/joy';
import { SearchBox } from './SearchBox';
import { DateFilterComponent } from './DateFilterComponent';
import { MetadataFilterPanel } from './MetadataFilterPanel';
import dayjs from 'dayjs';
import { FilterState } from '@client/app/hooks/useUserActivityFilters';

interface UserActivityFiltersProps {
  filters: FilterState;
  updateFilter: (key: keyof FilterState, value: any) => void;
  rawData?: any[];
}

export const UserActivityFilters: React.FC<UserActivityFiltersProps> = ({ filters, updateFilter, rawData = [] }) => {
  // Extract metadata fields from raw data
  const metadataFields = React.useMemo(() => {
    const fields = new Set<string>();
    rawData.forEach(item => {
      if (item.metadata) {
        Object.keys(item.metadata).forEach(field => fields.add(field));
      }
      if (item.users) {
        item.users.forEach((user: any) => {
          if (user.metadata) {
            Object.keys(user.metadata).forEach(field => fields.add(field));
          }
        });
      }
    });
    return Array.from(fields).sort();
  }, [rawData]);

  return (
    <Box sx={{ mb: 3 }}>
      <Typography level="title-sm" sx={{ mb: 1, fontWeight: 500 }}>
        Advanced Filters
      </Typography>
      <Stack spacing={2}>
        <DateFilterComponent
          startDate={filters.startDate}
          endDate={filters.endDate}
          onStartDateChange={value => updateFilter('startDate', value)}
          onEndDateChange={value => updateFilter('endDate', value)}
          onRangeSelect={days => {
            updateFilter('startDate', dayjs().subtract(days, 'days').format('YYYY-MM-DD'));
            updateFilter('endDate', dayjs().format('YYYY-MM-DD'));
          }}
        />

        <Divider />

        <Grid container spacing={2}>
          <Grid xs={12} md={6}>
            <SearchBox
              value={filters.counterNameSearch}
              onChange={value => updateFilter('counterNameSearch', value)}
              placeholder="Search by Counter Name"
            />
          </Grid>
          <Grid xs={12} md={6}>
            <SearchBox
              value={filters.userEmailSearch}
              onChange={value => updateFilter('userEmailSearch', value)}
              placeholder="Search by User Email"
            />
          </Grid>
        </Grid>

        <Divider />

        <MetadataFilterPanel
          onApplyFilters={filters => updateFilter('metadataFilters', filters)}
          initialFilters={filters.metadataFilters}
          metadataFields={metadataFields}
        />
      </Stack>
    </Box>
  );
};
