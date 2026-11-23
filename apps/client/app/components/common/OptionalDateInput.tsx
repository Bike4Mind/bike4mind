import { FC, useEffect, useRef } from 'react';
import { Button, IconButton, Input, Stack, Typography } from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import EventIcon from '@mui/icons-material/Event';

interface OptionalDateInputProps {
  /** YYYY-MM-DD, or '' for no date. */
  value: string;
  onChange: (value: string) => void;
  /** Shown while there is no date, e.g. "No expiry". */
  emptyLabel: string;
  /** Text of the button that adds a date, e.g. "Set expiry date". */
  setLabel: string;
  /** Accessible name of the button that removes the date. */
  clearLabel: string;
  /** The day filled in when the user adds a date. */
  initialDate: () => string;
  min?: string;
  max?: string;
  size?: 'sm' | 'md';
  'aria-label'?: string;
  /** Goes on the native date input; the set and clear buttons get `-set-btn` and `-clear-btn` suffixes. */
  testId: string;
}

/**
 * A date field whose empty state is explicit. Safari draws today's date inside an empty `<input type="date">`,
 * which reads as a value that is not there, so while empty this renders `emptyLabel` and a button instead, and
 * adding a date fills in a real one so the field never shows a day it will not send.
 */
export const OptionalDateInput: FC<OptionalDateInputProps> = ({
  value,
  onChange,
  emptyLabel,
  setLabel,
  clearLabel,
  initialDate,
  min,
  max,
  size = 'md',
  'aria-label': ariaLabel,
  testId,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const focusOnShow = useRef(false);

  useEffect(() => {
    if (value === '' || !focusOnShow.current) return;
    focusOnShow.current = false;
    inputRef.current?.focus();
  }, [value]);

  if (value === '') {
    return (
      <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
        <Typography level={size === 'sm' ? 'body-sm' : 'body-md'} data-testid={`${testId}-empty`}>
          {emptyLabel}
        </Typography>
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          startDecorator={<EventIcon />}
          onClick={() => {
            focusOnShow.current = true;
            onChange(initialDate());
          }}
          data-testid={`${testId}-set-btn`}
        >
          {setLabel}
        </Button>
      </Stack>
    );
  }

  return (
    <Input
      type="date"
      size={size}
      value={value}
      onChange={event => onChange(event.target.value)}
      endDecorator={
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label={clearLabel}
          onClick={() => onChange('')}
          data-testid={`${testId}-clear-btn`}
        >
          <CloseIcon />
        </IconButton>
      }
      slotProps={{ input: { ref: inputRef, min, max, 'aria-label': ariaLabel, 'data-testid': testId } }}
    />
  );
};
