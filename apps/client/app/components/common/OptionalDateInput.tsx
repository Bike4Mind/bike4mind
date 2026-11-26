import { FC, useEffect, useRef, useState } from 'react';
import { Box, Button, IconButton, Input, Stack, Typography } from '@mui/joy';
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
  /**
   * Disables the input and both buttons, so the field cannot be opened, edited or cleared.
   * Left unset, the date input follows a wrapping FormControl's `disabled`; the buttons do not.
   */
  disabled?: boolean;
  /** Left unset, the date input follows a wrapping FormControl's `error`; the set button does not. */
  error?: boolean;
  'aria-label'?: string;
  /** Goes on the native date input; the empty label and the buttons get `-empty`, `-set-btn` and `-clear-btn` suffixes. */
  testId: string;
}

/**
 * A date field whose empty state is explicit. Safari draws today's date inside an empty `<input type="date">`,
 * which reads as a value that is not there, so while empty this renders `emptyLabel` and a button instead, and
 * adding a date fills in a real one so the field never shows a day it will not send.
 * Browsers report '' while any segment is incomplete, so the input stays mounted while focus is inside it and
 * only collapses on blur or the clear button; otherwise retyping a segment would unmount it mid-edit.
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
  disabled: disabledProp,
  error: errorProp,
  'aria-label': ariaLabel,
  testId,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const setButtonRef = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<'input' | 'set' | null>(null);
  const [focusedWithin, setFocusedWithin] = useState(false);
  const disabled = disabledProp ?? false;
  const error = errorProp ?? false;
  // A disabled input loses focus without a reliable blur event, which would otherwise leave focusedWithin stuck.
  const [wasDisabled, setWasDisabled] = useState(disabled);
  if (disabled !== wasDisabled) {
    setWasDisabled(disabled);
    if (disabled) setFocusedWithin(false);
  }
  const empty = value === '' && !focusedWithin;

  useEffect(() => {
    const target = pendingFocus.current === 'input' ? inputRef : pendingFocus.current === 'set' ? setButtonRef : null;
    if (!target?.current) return;
    pendingFocus.current = null;
    target.current.focus();
  }, [empty]);

  if (empty) {
    return (
      <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
        <Typography level={size === 'sm' ? 'body-sm' : 'body-md'} data-testid={`${testId}-empty`}>
          {emptyLabel}
        </Typography>
        <Button
          size="sm"
          variant="outlined"
          color={error ? 'danger' : 'neutral'}
          disabled={disabled}
          startDecorator={<EventIcon />}
          ref={setButtonRef}
          onClick={() => {
            pendingFocus.current = 'input';
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
    <Box
      component="span"
      sx={{ display: 'contents' }}
      onFocus={() => setFocusedWithin(true)}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusedWithin(false);
      }}
    >
      <Input
        type="date"
        size={size}
        value={value}
        // The raw props, not the defaulted ones: an explicit false would override a wrapping FormControl.
        disabled={disabledProp}
        error={errorProp}
        onChange={event => onChange(event.target.value)}
        endDecorator={
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            disabled={disabled}
            aria-label={clearLabel}
            onClick={() => {
              pendingFocus.current = 'set';
              setFocusedWithin(false);
              onChange('');
            }}
            data-testid={`${testId}-clear-btn`}
          >
            <CloseIcon />
          </IconButton>
        }
        slotProps={{
          root: { 'data-testid': `${testId}-root` },
          input: { ref: inputRef, min, max, 'aria-label': ariaLabel, 'data-testid': testId },
        }}
      />
    </Box>
  );
};
