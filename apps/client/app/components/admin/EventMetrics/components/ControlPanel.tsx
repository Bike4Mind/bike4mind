import React from 'react';
import { Button, Input, Stack, Typography } from '@mui/joy';
import dayjs from 'dayjs';
import { EVENT_CATEGORIES } from '@server/admin/categorizeEvent';
import { FilterChip, SegmentedControl, type SegmentedOption } from '../../shared';
import { adminFocusScope } from '../../shared/adminStyles';
import type { DateRangePreset } from '../hooks/useEventMetricsState';
import type { EventMetric } from '../types';

interface ControlPanelProps {
  metrics: EventMetric[];
  dateRange: DateRangePreset;
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
  onClearFilters: () => void;
  onSetDateRange: (preset: DateRangePreset) => void;
  /** Any range or filter is set; shows Clear filters. */
  hasFilters: boolean;
  hideCategoryFilter?: boolean;
}

// The guide caps a SegmentedControl at four modes, so the common windows are segments and every
// other preset sits in the Range chip. While a chip preset is active no segment is selected.
const RANGE_SEGMENTS: readonly SegmentedOption<DateRangePreset>[] = [
  { value: 'last7days', label: '7d' },
  { value: 'last30days', label: '30d' },
  { value: 'last90days', label: '90d' },
  { value: 'all', label: 'All time' },
];

const RANGE_CHIP_OPTIONS: readonly { value: DateRangePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'thisMonth', label: 'This month' },
  { value: 'lastMonth', label: 'Last month' },
  { value: 'custom', label: 'Custom' },
];

const isChipRange = (range: DateRangePreset) => RANGE_CHIP_OPTIONS.some(option => option.value === range);

const CATEGORY_OPTIONS = EVENT_CATEGORIES.map(category => ({ value: category, label: category }));

// Native date inputs accept 5- and 6-digit years; these bounds and DAY_PATTERN keep the picker to
// four-digit years.
const MIN_DAY = '2000-01-01';
const MAX_DAY = '9999-12-31';
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isoToDay = (iso: string) => (iso ? dayjs(iso).format('YYYY-MM-DD') : '');

/** A picked local day as the ISO instant at its start or end; '' for a cleared or partial input. */
const dayToIso = (day: string, edge: 'start' | 'end') => {
  const parsed = DAY_PATTERN.test(day) ? dayjs(day) : null;
  if (!parsed?.isValid()) return '';
  return (edge === 'start' ? parsed.startOf('day') : parsed.endOf('day')).toISOString();
};

/**
 * The event filters as one row that wraps as a whole: the quick ranges, the Range chip with the
 * other presets, then one chip per filter. Custom shows two native date inputs in the row, because
 * the admin toolkit has no date picker yet. A pick applies on its own; the page applies the filter
 * state, so there is no Apply button.
 */
export const ControlPanel: React.FC<ControlPanelProps> = ({
  metrics,
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
  onClearFilters,
  onSetDateRange,
  hasFilters,
  hideCategoryFilter,
}) => {
  const eventOptions = React.useMemo(
    () =>
      Array.from(new Set(metrics.map(m => m.eventName)))
        .sort()
        .map(name => ({ value: name, label: name })),
    [metrics]
  );

  const userOptions = React.useMemo(() => {
    const users = new Map<string, string>();
    metrics.forEach(m => users.set(m.user.userId, m.user.userName));
    return Array.from(users, ([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [metrics]);

  return (
    <Stack
      direction="row"
      flexWrap="wrap"
      alignItems="center"
      gap={1}
      sx={adminFocusScope}
      data-testid="event-metrics-filter-row"
    >
      <SegmentedControl
        options={RANGE_SEGMENTS}
        value={dateRange}
        onChange={onSetDateRange}
        aria-label="Date range"
        data-testid="event-metrics-range"
      />
      <FilterChip
        id="event-range"
        label="Range"
        value={isChipRange(dateRange) ? dateRange : undefined}
        options={RANGE_CHIP_OPTIONS}
        onChange={value => onSetDateRange(RANGE_CHIP_OPTIONS.find(option => option.value === value)?.value ?? 'all')}
      />
      {dateRange === 'custom' && (
        <>
          <Input
            size="sm"
            type="date"
            value={isoToDay(dateFrom)}
            onChange={event => setDateFrom(dayToIso(event.target.value, 'start'))}
            slotProps={{
              input: {
                'aria-label': 'From',
                min: MIN_DAY,
                max: isoToDay(dateTo) || MAX_DAY,
                'data-testid': 'event-metrics-date-from',
              },
            }}
          />
          <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
            to
          </Typography>
          <Input
            size="sm"
            type="date"
            value={isoToDay(dateTo)}
            onChange={event => setDateTo(dayToIso(event.target.value, 'end'))}
            slotProps={{
              input: {
                'aria-label': 'To',
                min: isoToDay(dateFrom) || MIN_DAY,
                max: MAX_DAY,
                'data-testid': 'event-metrics-date-to',
              },
            }}
          />
        </>
      )}
      {!hideCategoryFilter && (
        <FilterChip
          id="event-category"
          label="Category"
          value={eventCategoryFilter || undefined}
          options={CATEGORY_OPTIONS}
          onChange={value => setEventCategoryFilter(value ?? '')}
        />
      )}
      <FilterChip
        id="event-name"
        label="Event"
        value={eventFilter || undefined}
        options={eventOptions}
        onChange={value => setEventFilter(value ?? '')}
      />
      <FilterChip
        id="event-user"
        label="User"
        value={userFilter || undefined}
        options={userOptions}
        onChange={value => setUserFilter(value ?? '')}
      />
      {hasFilters && (
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          onClick={onClearFilters}
          data-testid="event-metrics-clear-filters-btn"
        >
          Clear filters
        </Button>
      )}
    </Stack>
  );
};
