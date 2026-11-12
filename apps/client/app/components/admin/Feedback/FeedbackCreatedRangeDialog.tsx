import { useState } from 'react';
import { Button, FormControl, FormHelperText, FormLabel, Input, Stack } from '@mui/joy';
import dayjs from 'dayjs';
import { AdminDialog, AdminDialogFooter } from '../shared/AdminDialog';

const DAY_FORMAT = 'YYYY-MM-DD';
const DEFAULT_RANGE_DAYS = 7;

export type CreatedRange = { createdFrom: string | undefined; createdTo: string | undefined };

/** "Nov 1 - Nov 8", "Since Nov 1" or "Until Nov 8"; the year only when it is not this one. */
export function formatCreatedRange({ createdFrom, createdTo }: CreatedRange): string {
  const format = (day: string) => {
    const date = dayjs(day);
    return date.format(date.year() === dayjs().year() ? 'MMM D' : 'MMM D, YYYY');
  };
  if (createdFrom && createdTo) {
    return createdFrom === createdTo ? format(createdFrom) : `${format(createdFrom)} \u2013 ${format(createdTo)}`;
  }
  if (createdFrom) return `Since ${format(createdFrom)}`;
  if (createdTo) return `Until ${format(createdTo)}`;
  return '';
}

/**
 * Picks a custom created-date range for the Feedback list. The filter bar holds chips only (see
 * DESIGN_GUIDE.md), so the native date inputs live here, behind the Received chip's "Custom range".
 * Either end may be left open; days are the viewer's own, both inclusive.
 */
export function FeedbackCreatedRangeDialog({
  initial,
  onApply,
  onClose,
}: {
  initial: CreatedRange;
  onApply: (range: CreatedRange) => void;
  onClose: () => void;
}) {
  const today = dayjs().format(DAY_FORMAT);
  const isUnset = !initial.createdFrom && !initial.createdTo;
  const [from, setFrom] = useState(
    isUnset
      ? dayjs()
          .subtract(DEFAULT_RANGE_DAYS - 1, 'day')
          .format(DAY_FORMAT)
      : (initial.createdFrom ?? '')
  );
  const [to, setTo] = useState(isUnset ? today : (initial.createdTo ?? ''));

  const inverted = from !== '' && to !== '' && from > to;
  const empty = from === '' && to === '';

  const apply = () => {
    onApply({ createdFrom: from || undefined, createdTo: to || undefined });
    onClose();
  };

  return (
    <AdminDialog title="Choose a date range" onClose={onClose} width={400} data-testid="feedback-created-range-dialog">
      <Stack
        component="form"
        gap={2}
        onSubmit={event => {
          event.preventDefault();
          if (!inverted && !empty) apply();
        }}
      >
        <Stack direction="row" gap={1.5} flexWrap="wrap">
          <FormControl sx={{ flex: '1 1 140px' }}>
            <FormLabel>From</FormLabel>
            <Input
              type="date"
              value={from}
              onChange={event => setFrom(event.target.value)}
              slotProps={{ input: { max: to || today, 'data-testid': 'feedback-created-range-from-input' } }}
            />
          </FormControl>
          <FormControl sx={{ flex: '1 1 140px' }} error={inverted}>
            <FormLabel>To</FormLabel>
            <Input
              type="date"
              value={to}
              onChange={event => setTo(event.target.value)}
              slotProps={{ input: { min: from || undefined, 'data-testid': 'feedback-created-range-to-input' } }}
            />
            {inverted && <FormHelperText>Ends before it starts.</FormHelperText>}
          </FormControl>
        </Stack>
        <AdminDialogFooter>
          <Button variant="plain" color="neutral" onClick={onClose} data-testid="feedback-created-range-cancel-btn">
            Cancel
          </Button>
          <Button type="submit" disabled={inverted || empty} data-testid="feedback-created-range-apply-btn">
            Apply
          </Button>
        </AdminDialogFooter>
      </Stack>
    </AdminDialog>
  );
}
