import React, { useState, useEffect, useRef } from 'react';
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

/**
 * The value a date input shows, updated on every keystroke. A parent that commits the change
 * asynchronously (a router navigate) re-renders with the old value first, and React writing that
 * back into the input resets the browser's year-typing buffer. So a prop change is only adopted
 * while the input is not focused, and on blur.
 */
const useDateDraft = (value: string) => {
  const [draft, setDraft] = useState(value);
  const isFocused = useRef(false);

  useEffect(() => {
    if (!isFocused.current) setDraft(value);
  }, [value]);

  return {
    draft,
    setDraft,
    onFocus: () => {
      isFocused.current = true;
    },
    onBlur: () => {
      isFocused.current = false;
      setDraft(value);
    },
  };
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
  const startDraft = useDateDraft(startDate);
  const endDraft = useDateDraft(endDate);

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
            value={startDraft.draft}
            onChange={event => {
              startDraft.setDraft(event.target.value);
              onChange({ startDate: event.target.value, endDate });
            }}
            onFocus={startDraft.onFocus}
            onBlur={startDraft.onBlur}
            slotProps={{ input: { max: endDate || today(), 'data-testid': 'date-filter-start-input' } }}
          />
        </FormControl>
        <FormControl>
          <FormLabel>End Date</FormLabel>
          <Input
            type="date"
            value={endDraft.draft}
            onChange={event => {
              endDraft.setDraft(event.target.value);
              onChange({ startDate, endDate: event.target.value });
            }}
            onFocus={endDraft.onFocus}
            onBlur={endDraft.onBlur}
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
