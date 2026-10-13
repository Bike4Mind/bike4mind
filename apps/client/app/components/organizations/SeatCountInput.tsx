import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import { Box, IconButton, Input } from '@mui/joy';
import { useEffect, useState } from 'react';

interface SeatCountInputProps {
  /** Seat count already clamped to [min, max] by the caller. */
  value: number;
  min: number;
  max: number;
  /** Receives the parsed number as typed; the caller clamps on read. */
  onChange: (seats: number) => void;
  /** Reports true while the field holds text that is not a number, so the caller can block submit. */
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

/** Stepper buttons around a typeable seat count; the text is held as a draft while focused and snaps into range on blur. */
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
  // Raw text while editing, so it can be empty or out of range mid-edit; null shows the clamped value.
  const [draft, setDraft] = useState<string | null>(null);
  const isInvalid = draft !== null && !Number.isFinite(Number.parseFloat(draft));

  useEffect(() => {
    onInvalidChange?.(isInvalid);
    return () => onInvalidChange?.(false);
  }, [isInvalid, onInvalidChange]);

  const handleChange = (text: string) => {
    setDraft(text);
    const parsed = Number.parseFloat(text);
    if (Number.isFinite(parsed)) onChange(Math.round(parsed));
  };

  const step = (delta: number) => {
    setDraft(null);
    onChange(Math.min(Math.max(value + delta, min), max));
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }} className={`${classNamePrefix}-control`}>
      <IconButton
        variant={buttonVariant}
        color="neutral"
        size={size}
        disabled={disabled || value <= min}
        onClick={() => step(-1)}
        aria-label="Decrease seats"
        className={`${classNamePrefix}-decrease`}
      >
        <RemoveIcon />
      </IconButton>
      <Input
        type="number"
        size={size}
        value={draft ?? String(value)}
        onChange={e => handleChange(e.target.value)}
        // An empty or unparseable field falls back to the last valid size.
        onBlur={() => setDraft(null)}
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
        disabled={disabled || value >= max}
        onClick={() => step(1)}
        aria-label="Increase seats"
        className={`${classNamePrefix}-increase`}
      >
        <AddIcon />
      </IconButton>
    </Box>
  );
};

export default SeatCountInput;
