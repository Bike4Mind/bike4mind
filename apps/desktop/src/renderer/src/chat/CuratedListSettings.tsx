import { useEffect, useState } from 'react';
import Stack from '@mui/joy/Stack';
import Switch from '@mui/joy/Switch';
import Typography from '@mui/joy/Typography';
import type { CuratedListSettings as Settings } from '@shared/models';

export function curatedListSummary(settings: Settings | null): string {
  if (!settings) return 'Loading...';
  if (!settings.available) return 'This build uses the list bundled with the app.';
  return settings.enabled ? 'Checks for an updated list when you open Models.' : 'Uses the bundled list only.';
}

export function useCuratedListSettings(): [Settings | null, (enabled: boolean) => void] {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    let live = true;
    window.b4m.models.getCuratedSettings().then(
      next => live && setSettings(next),
      () => undefined
    );
    return () => {
      live = false;
    };
  }, []);
  const setEnabled = (enabled: boolean) => {
    void window.b4m.models.setCuratedEnabled(enabled).then(setSettings, () => undefined);
  };
  return [settings, setEnabled];
}

/** The off switch for fetching the signed curated models list. */
export function CuratedListSettings({
  settings,
  onEnabled,
}: {
  settings: Settings | null;
  onEnabled: (enabled: boolean) => void;
}) {
  return (
    <Stack spacing={1.25}>
      <Typography level="body-xs" textColor="text.tertiary">
        Desktop checks catalog.bike4mind.com for an updated list when you open Models, at most every 6 hours. Nothing is
        downloaded automatically.
      </Typography>
      <Switch
        size="sm"
        checked={settings?.available === true && settings.enabled}
        disabled={!settings?.available}
        onChange={event => onEnabled(event.target.checked)}
        sx={{ alignSelf: 'flex-start' }}
        slotProps={{
          input: { 'aria-label': 'Check for curated list updates', 'data-testid': 'settings-curated-source-switch' },
        }}
      />
    </Stack>
  );
}
