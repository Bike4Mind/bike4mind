import { useState } from 'react';
import { FormControl, FormLabel, Input } from '@mui/joy';

const MS_PER_S = 1000;

/**
 * A seconds field that edits a ms spec value. It keeps its own text while typing so "1." is not rejected mid-entry,
 * and commits on every parseable change; an out-of-range value commits and the validator flags it.
 */
const SecondsField = ({
  label,
  valueMs,
  testId,
  onCommit,
}: {
  label: string;
  valueMs: number;
  testId: string;
  onCommit: (ms: number) => void;
}) => {
  const [text, setText] = useState(String(valueMs / MS_PER_S));
  const [syncedMs, setSyncedMs] = useState(valueMs);
  // Adopt an outside change (a drag, a clamp) during render rather than in an effect.
  if (syncedMs !== valueMs) {
    setSyncedMs(valueMs);
    if (Math.round(Number(text) * MS_PER_S) !== valueMs) setText(String(valueMs / MS_PER_S));
  }
  return (
    <FormControl size="sm">
      <FormLabel>{label}</FormLabel>
      <Input
        type="number"
        value={text}
        slotProps={{ input: { min: 0, step: 0.1, 'data-testid': testId } }}
        endDecorator="s"
        onChange={event => {
          setText(event.target.value);
          const seconds = Number(event.target.value);
          if (event.target.value !== '' && Number.isFinite(seconds)) onCommit(Math.round(seconds * MS_PER_S));
        }}
      />
    </FormControl>
  );
};

export default SecondsField;
