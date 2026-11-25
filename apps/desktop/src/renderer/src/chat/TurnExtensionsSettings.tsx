import { useCallback, useEffect, useState } from 'react';
import Option from '@mui/joy/Option';
import Select from '@mui/joy/Select';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { MAX_TURN_EXTENSIONS, MIN_TURN_EXTENSIONS } from '@shared/turnExtensionSetting';

const CHOICES = Array.from(
  { length: MAX_TURN_EXTENSIONS - MIN_TURN_EXTENSIONS + 1 },
  (_, index) => MIN_TURN_EXTENSIONS + index
);

export function turnExtensionsSummary(extensions: number | null): string {
  if (extensions === null) return 'Loading';
  if (extensions === 0) return 'Always stop at the turn budget';
  return `Keep going up to ${extensions} ${extensions === 1 ? 'extension' : 'extensions'}`;
}

function optionLabel(count: number): string {
  return count === 0 ? 'Always stop' : String(count);
}

/** Loaded from main, which owns and validates the value. */
export function useTurnExtensions() {
  const [extensions, setExtensions] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void window.b4m.chat
      .getTurnExtensions()
      .then(next => {
        if (live) setExtensions(next);
      })
      .catch(err => {
        if (live) setError(`Could not load this setting. ${String(err)}`);
      });
    return () => {
      live = false;
    };
  }, []);
  const save = useCallback(async (next: number) => {
    setError(null);
    try {
      setExtensions(await window.b4m.chat.setTurnExtensions(next));
    } catch (err) {
      setError(`Could not save this setting. ${String(err)}`);
    }
  }, []);
  return [extensions, save, error] as const;
}

export function TurnExtensionsSettings({
  extensions,
  onChange,
  error,
}: {
  extensions: number | null;
  onChange: (extensions: number) => void;
  error: string | null;
}) {
  return (
    <Stack spacing={1}>
      <Select
        size="sm"
        value={extensions === null ? null : String(extensions)}
        disabled={extensions === null}
        onChange={(_event, next) => {
          if (next !== null) onChange(Number(next));
        }}
        sx={{ alignSelf: 'flex-start', minWidth: 140 }}
        slotProps={{
          button: { 'aria-label': 'Extra turns for long tasks', 'data-testid': 'settings-turn-extensions-select' },
        }}
      >
        {CHOICES.map(count => (
          <Option key={count} value={String(count)} data-testid={`settings-turn-extensions-option-${count}`}>
            {optionLabel(count)}
          </Option>
        ))}
      </Select>
      {error && (
        <Typography level="body-xs" color="danger" role="alert" data-testid="settings-turn-extensions-error">
          {error}
        </Typography>
      )}
    </Stack>
  );
}
