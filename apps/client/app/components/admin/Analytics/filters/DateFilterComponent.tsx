import React, { useState, useEffect } from 'react';
import { Box, FormControl, FormLabel, Input, Stack, Button } from '@mui/joy';
import dayjs from 'dayjs';
import { useAnalyticsStore } from '../store';

const getLocalDate = (daysOffset = 0) => {
  const now = dayjs();
  return daysOffset < 0 ? now.subtract(Math.abs(daysOffset), 'day').format('YYYY-MM-DD') : now.format('YYYY-MM-DD');
};

interface DateFilterComponentProps {
  startDate: string;
  endDate: string;
  onStartDateChange: (date: string) => void;
  onEndDateChange: (date: string) => void;
  onRangeSelect: (days: number) => void;
}

export const DateFilterComponent: React.FC<DateFilterComponentProps> = ({
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
  onRangeSelect,
}) => {
  const { dateFilters, setDateFilters } = useAnalyticsStore();
  const [activeRange, setActiveRange] = useState<number | null>(null);

  // Set initial active range based on date difference
  useEffect(() => {
    const start = dayjs(startDate);
    const end = dayjs(endDate);
    const diffDays = end.diff(start, 'day');
    const today = dayjs().format('YYYY-MM-DD');

    if (diffDays === 0 && end.format('YYYY-MM-DD') === today) {
      setActiveRange(0); // Today
    } else if (diffDays === 6 && end.format('YYYY-MM-DD') === today) {
      setActiveRange(7); // Last 7 days
    } else if (diffDays === 29 && end.format('YYYY-MM-DD') === today) {
      setActiveRange(30); // Last 30 days
    } else {
      setActiveRange(null); // Custom range
    }
  }, [startDate, endDate]);

  const handleStartDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newStartDate = e.target.value;
    setActiveRange(null); // Custom range when manually changed
    onStartDateChange(newStartDate);

    // Also update the store
    setDateFilters({
      ...dateFilters,
      startDate: newStartDate,
    });
  };

  const handleEndDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newEndDate = e.target.value;
    setActiveRange(null); // Custom range when manually changed
    onEndDateChange(newEndDate);

    // Also update the store
    setDateFilters({
      ...dateFilters,
      endDate: newEndDate,
    });
  };

  const handleRangeSelect = (days: number) => {
    setActiveRange(days);

    // Calculate new dates
    const newEndDate = getLocalDate(0); // Today
    const newStartDate =
      days === 0
        ? newEndDate // Today
        : getLocalDate(-days); // Past days

    // Update local state via props
    onStartDateChange(newStartDate);
    onEndDateChange(newEndDate);
    onRangeSelect(days);

    // Also update the store
    setDateFilters({
      startDate: newStartDate,
      endDate: newEndDate,
    });
  };

  return (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'flex-end' }}>
      {/* Date inputs — 2-column grid on mobile, inline row on desktop */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 1,
        }}
      >
        <FormControl>
          <FormLabel>Start Date</FormLabel>
          <Input
            type="date"
            value={startDate}
            onChange={handleStartDateChange}
            slotProps={{ input: { max: endDate || getLocalDate() } }}
          />
        </FormControl>
        <FormControl>
          <FormLabel>End Date</FormLabel>
          <Input
            type="date"
            value={endDate}
            onChange={handleEndDateChange}
            slotProps={{ input: { max: getLocalDate(), min: startDate } }}
          />
        </FormControl>
      </Box>

      {/* Preset buttons — always a row */}
      <Stack direction="row" spacing={1}>
        <Button
          size="sm"
          variant={activeRange === 0 ? 'solid' : 'outlined'}
          onClick={() => handleRangeSelect(0)}
          sx={{ flex: { xs: 1, sm: 'none' } }}
        >
          Today
        </Button>
        <Button
          size="sm"
          variant={activeRange === 7 ? 'solid' : 'outlined'}
          onClick={() => handleRangeSelect(7)}
          sx={{ flex: { xs: 1, sm: 'none' } }}
        >
          Last 7 Days
        </Button>
        <Button
          size="sm"
          variant={activeRange === 30 ? 'solid' : 'outlined'}
          onClick={() => handleRangeSelect(30)}
          sx={{ flex: { xs: 1, sm: 'none' } }}
        >
          Last 30 Days
        </Button>
      </Stack>
    </Stack>
  );
};
