import { useCallback, useEffect, useState } from 'react';
import Option from '@mui/joy/Option';
import Select from '@mui/joy/Select';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { MAX_AUTO_FIX_ATTEMPTS, MIN_AUTO_FIX_ATTEMPTS } from '@shared/autoFixSetting';

const CHOICES = Array.from(
  { length: MAX_AUTO_FIX_ATTEMPTS - MIN_AUTO_FIX_ATTEMPTS + 1 },
  (_, index) => MIN_AUTO_FIX_ATTEMPTS + index
);

export function autoFixAttemptsSummary(attempts: number | null): string {
  if (attempts === null) return 'Loading';
  return `Up to ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'} per pull request`;
}

/** Loaded from main, which owns and validates the value. */
export function useAutoFixAttempts() {
  const [attempts, setAttempts] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void window.b4m.pullRequests
      .getAutoFixAttempts()
      .then(next => {
        if (live) setAttempts(next);
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
      setAttempts(await window.b4m.pullRequests.setAutoFixAttempts(next));
    } catch (err) {
      setError(`Could not save this setting. ${String(err)}`);
    }
  }, []);
  return [attempts, save, error] as const;
}

export function AutoFixAttemptsSettings({
  attempts,
  onChange,
  error,
}: {
  attempts: number | null;
  onChange: (attempts: number) => void;
  error: string | null;
}) {
  return (
    <Stack spacing={1}>
      <Select
        size="sm"
        value={attempts === null ? null : String(attempts)}
        disabled={attempts === null}
        onChange={(_event, next) => {
          if (next) onChange(Number(next));
        }}
        sx={{ alignSelf: 'flex-start', minWidth: 120 }}
        slotProps={{ button: { 'aria-label': 'Auto-fix attempts', 'data-testid': 'settings-autofix-attempts-select' } }}
      >
        {CHOICES.map(count => (
          <Option key={count} value={String(count)} data-testid={`settings-autofix-attempts-option-${count}`}>
            {String(count)}
          </Option>
        ))}
      </Select>
      {error && (
        <Typography level="body-xs" color="danger" role="alert" data-testid="settings-autofix-attempts-error">
          {error}
        </Typography>
      )}
    </Stack>
  );
}
