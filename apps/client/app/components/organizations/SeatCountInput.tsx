import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import { Box, IconButton, Input, Typography } from '@mui/joy';
import { useEffect, useState } from 'react';

interface SeatCountInputProps {
  /** Last valid seat count, always within [min, max]. */
  value: number;
  min: number;
  max: number;
  /** Receives the typed number only while it is a whole in-range value, so the caller never sees a count it would have to clamp. */
  onChange: (seats: number) => void;
  /** Reports true while the field holds an empty, non-numeric or out-of-range draft, so the caller can block submit. */
  onInvalidChange?: (invalid: boolean) => void;
  disabled?: boolean;
  size?: 'md' | 'lg';
  buttonVariant?: 'outlined' | 'soft';
  ariaLabel: string;
  /** Applied to the number input. */
  testId: string;
  /** Prefix for the `-control`, `-decrease`, `-value` and `-increase` class names. */
  classNamePrefix: string;
}

/** Stepper buttons around a typeable seat count; an out-of-range draft stays visible as an error rather than being clamped. */
const SeatCountInput = ({
  value,
  min,
  max,
  onChange,
  onInvalidChange,
  disabled = false,
  size = 'md',
  buttonVariant = 'outlined',
  ariaLabel,
  testId,
  classNamePrefix,
}: SeatCountInputProps) => {
  // Raw text while editing, so it can be empty or out of range; null shows the last valid value.
  const [draft, setDraft] = useState<string | null>(null);
  const [prevValue, setPrevValue] = useState(value);
  const clamp = (n: number) => Math.min(Math.max(n, min), max);
  const parsedDraft = draft === null ? null : Math.round(Number.parseFloat(draft));
  const isInvalid = parsedDraft !== null && !(Number.isFinite(parsedDraft) && parsedDraft >= min && parsedDraft <= max);
  // The number the field stands for, clamped. The stepper works from it so its disabled state matches
  // the value on screen even while a draft sits out of range.
  const displayed = parsedDraft !== null && Number.isFinite(parsedDraft) ? clamp(parsedDraft) : value;
  const label = ariaLabel.toLowerCase();

  // A changed parent value overrides a held valid draft, unless the new range clamping the old value
  // moved it, in which case the range effect re-reports the draft instead of dropping it.
  if (value !== prevValue) {
    setPrevValue(value);
    if (parsedDraft !== null && !isInvalid && parsedDraft !== value && value !== clamp(prevValue)) setDraft(null);
  }

  useEffect(() => {
    onInvalidChange?.(isInvalid);
    return () => onInvalidChange?.(false);
  }, [isInvalid, onInvalidChange]);

  // A held draft can become valid when min/max move (e.g. a member leaves); report it so the parent
  // submits the number on screen rather than the last valid value.
  useEffect(() => {
    if (parsedDraft !== null && !isInvalid && parsedDraft !== value) onChange(parsedDraft);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only min/max moving should re-report a held draft
  }, [min, max]);

  const handleChange = (text: string) => {
    setDraft(text);
    const parsed = Math.round(Number.parseFloat(text));
    if (Number.isFinite(parsed) && parsed >= min && parsed <= max) onChange(parsed);
  };

  const step = (delta: number) => {
    setDraft(null);
    onChange(clamp(displayed + delta));
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }} className={`${classNamePrefix}-wrapper`}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }} className={`${classNamePrefix}-control`}>
        <IconButton
          variant={buttonVariant}
          color="neutral"
          size={size}
          disabled={disabled || displayed <= min}
          onClick={() => step(-1)}
          aria-label={`Decrease ${label}`}
          className={`${classNamePrefix}-decrease`}
        >
          <RemoveIcon />
        </IconButton>
        <Input
          type="number"
          size={size}
          value={draft ?? String(value)}
          onChange={e => handleChange(e.target.value)}
          // Only a valid draft is normalised (e.g. 7.4 to 7); an invalid one stays so a click on submit cannot act on a value the user never saw.
          onBlur={() => {
            if (!isInvalid) setDraft(null);
          }}
          disabled={disabled}
          error={isInvalid}
          slotProps={{ input: { min, max, step: 1, 'aria-label': ariaLabel, 'data-testid': testId } }}
          sx={{ width: '88px', '& input': { textAlign: 'center' } }}
          className={`${classNamePrefix}-value`}
        />
        <IconButton
          variant={buttonVariant}
          color="neutral"
          size={size}
          disabled={disabled || displayed >= max}
          onClick={() => step(1)}
          aria-label={`Increase ${label}`}
          className={`${classNamePrefix}-increase`}
        >
          <AddIcon />
        </IconButton>
      </Box>
      {isInvalid && (
        <Typography level="body-xs" color="danger" role="alert" data-testid={`${testId}-error`}>
          Must be between {min} and {max}
        </Typography>
      )}
    </Box>
  );
};

export default SeatCountInput;
