import React, { useState } from 'react';
import {
  Box,
  Button,
  FormControl,
  FormLabel,
  Input,
  Select,
  Option,
  Stack,
  Typography,
  IconButton,
  Tooltip,
} from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import ClearIcon from '@mui/icons-material/Clear';
import TuneIcon from '@mui/icons-material/Tune';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import type { EventMetric } from '../types';

interface ControlPanelProps {
  metrics: EventMetric[];
  filteredMetrics: EventMetric[];
  dateFrom: string;
  dateTo: string;
  userFilter: string;
  eventFilter: string;
  eventCategoryFilter: string;
  setDateFrom: (value: string) => void;
  setDateTo: (value: string) => void;
  setUserFilter: (value: string) => void;
  setEventFilter: (value: string) => void;
  setEventCategoryFilter: (value: string) => void;
  onRefresh: () => void;
  onClearFilters: () => void;
  onSetDateRange: (preset: string) => void;
  onApplyFilters: () => void;
  isLoading: boolean;
  hideCategoryFilter?: boolean;
}

const EVENT_CATEGORIES = [
  'Session',
  'File',
  'Curation',
  'Project',
  'Auth',
  'Modal',
  'Feedback',
  'Invite',
  'Organization',
  'AI',
  'LLM',
  'Other',
];

export const ControlPanel: React.FC<ControlPanelProps> = ({
  metrics,
  filteredMetrics,
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
  onRefresh,
  onClearFilters,
  onSetDateRange,
  onApplyFilters,
  isLoading,
  hideCategoryFilter,
}) => {
  const isMobile = useIsMobile();
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const filtersOpen = !isMobile || mobileFiltersOpen;

  const uniqueEventNames = React.useMemo(() => {
    const names = new Set<string>();
    if (Array.isArray(metrics)) {
      metrics.forEach(m => names.add(m.eventName));
    }
    return Array.from(names).sort();
  }, [metrics]);

  const uniqueUserNames = React.useMemo(() => {
    const users = new Map<string, string>();
    if (Array.isArray(metrics)) {
      metrics.forEach(m => users.set(m.user.userId, m.user.userName));
    }
    return Array.from(users.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [metrics]);

  const stats = [
    { label: 'Total Events', value: metrics.length },
    { label: 'Filtered', value: filteredMetrics.length },
    { label: 'Unique Events', value: uniqueEventNames.length },
    { label: 'Unique Users', value: uniqueUserNames.length },
  ];

  return (
    <Box sx={{ mb: { xs: 1, sm: 3 } }}>
      {/* Quick Stats - 2x2 grid on mobile, single row on desktop */}
      <Box
        sx={{
          mb: 2,
          p: { xs: 1.5, sm: 2 },
          bgcolor: 'background.level1',
          borderRadius: 'sm',
          display: 'grid',
          gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(4, 1fr)' },
          gap: { xs: 1, sm: 0 },
        }}
      >
        {stats.map(stat => (
          <Box
            key={stat.label}
            sx={{
              p: { xs: 1, sm: 0 },
              bgcolor: { xs: 'background.surface', sm: 'transparent' },
              borderRadius: { xs: 'sm', sm: 0 },
            }}
          >
            <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
              {stat.label}
            </Typography>
            <Typography level="h4">{stat.value}</Typography>
          </Box>
        ))}
      </Box>

      {/* Filters toggle - mobile only */}
      {isMobile && (
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          startDecorator={<TuneIcon />}
          endDecorator={mobileFiltersOpen ? <KeyboardArrowUpIcon /> : <KeyboardArrowDownIcon />}
          onClick={() => setMobileFiltersOpen(v => !v)}
          sx={{ mb: 0.5, width: '100%' }}
        >
          Filters
        </Button>
      )}

      {/* Filters - collapsible on mobile */}
      {filtersOpen && (
        <Stack spacing={2}>
          {/* Date Range Presets - 3-per-row grid on mobile, wrapping row on desktop */}
          <Box>
            <FormLabel sx={{ mb: 1 }}>Quick Date Ranges</FormLabel>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: 'repeat(3, 1fr)', sm: 'repeat(6, auto)' },
                gap: 1,
              }}
            >
              {[
                { key: 'today', label: 'Today' },
                { key: 'yesterday', label: 'Yesterday' },
                { key: 'last7days', label: 'Last 7 Days' },
                { key: 'last30days', label: 'Last 30 Days' },
                { key: 'thisMonth', label: 'This Month' },
                { key: 'lastMonth', label: 'Last Month' },
              ].map(({ key, label }) => (
                <Button
                  key={key}
                  size="sm"
                  variant="outlined"
                  onClick={() => onSetDateRange(key)}
                  data-testid={`date-preset-${key}-btn`}
                  sx={{ width: '100%' }}
                >
                  {label}
                </Button>
              ))}
            </Box>
          </Box>

          {/* Date Range Inputs - always 2 columns */}
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: 2,
            }}
          >
            <FormControl>
              <FormLabel>From Date</FormLabel>
              <Input
                type="datetime-local"
                value={
                  dateFrom
                    ? new Date(new Date(dateFrom).getTime() - new Date().getTimezoneOffset() * 60000)
                        .toISOString()
                        .slice(0, 16)
                    : ''
                }
                onChange={e => setDateFrom(e.target.value ? new Date(e.target.value).toISOString() : '')}
                data-testid="date-from-input"
              />
            </FormControl>
            <FormControl>
              <FormLabel>To Date</FormLabel>
              <Input
                type="datetime-local"
                value={
                  dateTo
                    ? new Date(new Date(dateTo).getTime() - new Date().getTimezoneOffset() * 60000)
                        .toISOString()
                        .slice(0, 16)
                    : ''
                }
                onChange={e => setDateTo(e.target.value ? new Date(e.target.value).toISOString() : '')}
                data-testid="date-to-input"
              />
            </FormControl>
          </Box>

          {/* Filter Dropdowns - 2-column grid, User spans full width */}
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(3, 1fr)' },
              gap: 2,
            }}
          >
            {!hideCategoryFilter && (
              <FormControl>
                <FormLabel>Event Category</FormLabel>
                <Select
                  value={eventCategoryFilter}
                  onChange={(_, value) => setEventCategoryFilter(value || '')}
                  placeholder="All Categories"
                  data-testid="event-category-filter"
                >
                  <Option value="">All Categories</Option>
                  {EVENT_CATEGORIES.map(category => (
                    <Option key={category} value={category}>
                      {category}
                    </Option>
                  ))}
                </Select>
              </FormControl>
            )}

            <FormControl>
              <FormLabel>Event Name</FormLabel>
              <Select
                value={eventFilter}
                onChange={(_, value) => setEventFilter(value || '')}
                placeholder="All Events"
                data-testid="event-name-filter"
              >
                <Option value="">All Events</Option>
                {uniqueEventNames.map(name => (
                  <Option key={name} value={name}>
                    {name}
                  </Option>
                ))}
              </Select>
            </FormControl>
          </Box>

          {/* User filter + Action Buttons - same row */}
          <Stack direction="row" spacing={1} alignItems="flex-end">
            <FormControl sx={{ flex: 1 }}>
              <FormLabel>User</FormLabel>
              <Select
                value={userFilter}
                onChange={(_, value) => setUserFilter(value || '')}
                placeholder="All Users"
                data-testid="user-filter"
              >
                <Option value="">All Users</Option>
                {uniqueUserNames.map(([userId, userName]) => (
                  <Option key={userId} value={userId}>
                    {userName}
                  </Option>
                ))}
              </Select>
            </FormControl>
            <Tooltip title="Clear all filters">
              <IconButton
                variant="outlined"
                color="neutral"
                onClick={onClearFilters}
                disabled={isLoading}
                data-testid="clear-filters-btn"
              >
                <ClearIcon />
              </IconButton>
            </Tooltip>
            <Button variant="solid" onClick={onApplyFilters} disabled={isLoading} data-testid="apply-filters-btn">
              Apply Filters
            </Button>
            <Tooltip title="Refresh data">
              <IconButton
                variant="outlined"
                color="primary"
                onClick={onRefresh}
                disabled={isLoading}
                data-testid="refresh-btn"
              >
                <RefreshIcon />
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>
      )}
    </Box>
  );
};
