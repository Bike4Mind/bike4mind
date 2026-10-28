import React from 'react';
import { Box, FormControl, FormLabel, Input, Stack, Button } from '@mui/joy';
import {
  DATE_PRESET_DAYS,
  getActivePreset,
  getPresetRange,
  today,
  type DatePresetDays,
  type DateRange,
} from '../dateRange';

const PRESET_BUTTONS: Record<DatePresetDays, { label: string; testId: string }> = {
  1: { label: 'Today', testId: 'date-filter-preset-today-btn' },
  7: { label: 'Last 7 Days', testId: 'date-filter-preset-7-btn' },
  30: { label: 'Last 30 Days', testId: 'date-filter-preset-30-btn' },
};

interface DateFilterComponentProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
}

/**
 * Controlled: the owner decides where the range lives. Changes are emitted as one whole range
 * so a preset never lands as two half-updates against a stale start or end.
 */
export const DateFilterComponent: React.FC<DateFilterComponentProps> = ({ value, onChange }) => {
  const { startDate, endDate } = value;
  const activePreset = getActivePreset(value);

  return (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'flex-end' }}>
      {/* Date inputs - 2-column grid on mobile, inline row on desktop */}
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
            onChange={event => onChange({ startDate: event.target.value, endDate })}
            slotProps={{ input: { max: endDate || today(), 'data-testid': 'date-filter-start-input' } }}
          />
        </FormControl>
        <FormControl>
          <FormLabel>End Date</FormLabel>
          <Input
            type="date"
            value={endDate}
            onChange={event => onChange({ startDate, endDate: event.target.value })}
            slotProps={{ input: { max: today(), min: startDate, 'data-testid': 'date-filter-end-input' } }}
          />
        </FormControl>
      </Box>

      {/* Preset buttons - always a row */}
      <Stack direction="row" spacing={1}>
        {DATE_PRESET_DAYS.map(days => (
          <Button
            key={days}
            size="sm"
            variant={activePreset === days ? 'solid' : 'outlined'}
            aria-pressed={activePreset === days}
            onClick={() => onChange(getPresetRange(days))}
            data-testid={PRESET_BUTTONS[days].testId}
            sx={{ flex: { xs: 1, sm: 'none' } }}
          >
            {PRESET_BUTTONS[days].label}
          </Button>
        ))}
      </Stack>
    </Stack>
  );
};
