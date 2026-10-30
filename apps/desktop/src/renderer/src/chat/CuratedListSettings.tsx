import { useCallback, useEffect, useRef, useState } from 'react';
import Button from '@mui/joy/Button';
import Stack from '@mui/joy/Stack';
import Switch from '@mui/joy/Switch';
import Typography from '@mui/joy/Typography';
import type { CuratedListSettings as Settings } from '@shared/models';

export function curatedListSummary(settings: Settings | null): string {
  if (!settings) return 'Loading...';
  if (!settings.available) return 'This build uses the list bundled with the app.';
  return settings.enabled ? 'Checks for an updated list when you open Models.' : 'Uses the bundled list only.';
}

export function useCuratedListSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const request = useRef(0);
  const reload = useCallback(async () => {
    const current = ++request.current;
    try {
      const next = await window.b4m.models.getCuratedSettings();
      if (current !== request.current) return;
      setSettings(next);
      setError(null);
    } catch {
      if (current === request.current) setError('Could not load the curated list setting.');
    }
  }, []);
  useEffect(() => {
    const unsubscribe = window.b4m.models.onCuratedChanged(() => void reload());
    void reload();
    return () => {
      ++request.current;
      unsubscribe();
    };
  }, [reload]);
  const setEnabled = async (enabled: boolean) => {
    const current = ++request.current;
    setSaving(true);
    setError(null);
    try {
      const next = await window.b4m.models.setCuratedEnabled(enabled);
      if (current === request.current) setSettings(next);
    } catch {
      setError('Could not save the curated list setting.');
    } finally {
      setSaving(false);
    }
  };
  return { settings, setEnabled, error, reload, saving };
}

/** The off switch for fetching the signed curated models list. */
export function CuratedListSettings({
  settings,
  onEnabled,
  error = null,
  onRetry,
  saving = false,
}: {
  settings: Settings | null;
  onEnabled: (enabled: boolean) => void;
  error?: string | null;
  onRetry?: () => void;
  saving?: boolean;
}) {
  return (
    <Stack spacing={1.25}>
      {settings?.available && (
        <Typography level="body-xs" textColor="text.tertiary">
          Desktop checks online for an updated list when you open Models, at most every 6 hours. No models are
          downloaded automatically.
        </Typography>
      )}
      {error && (
        <Stack spacing={0.5}>
          <Typography level="body-xs" color="danger" role="alert">
            {error}
          </Typography>
          {onRetry && (
            <Button size="sm" variant="plain" onClick={onRetry}>
              Try again
            </Button>
          )}
        </Stack>
      )}
      <Switch
        size="sm"
        checked={settings?.available === true && settings.enabled}
        disabled={!settings?.available || saving}
        onChange={event => onEnabled(event.target.checked)}
        sx={{ alignSelf: 'flex-start' }}
        slotProps={{
          input: { 'aria-label': 'Check for curated list updates', 'data-testid': 'settings-curated-source-switch' },
        }}
      />
    </Stack>
  );
}
