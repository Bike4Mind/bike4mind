import { useEffect, useState } from 'react';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { AppInfo } from '@shared/ipc';

function Row({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <Stack direction="row" justifyContent="space-between" spacing={2} data-testid={testId}>
      <Typography level="body-xs" textColor="text.tertiary" sx={{ flexShrink: 0 }}>
        {label}
      </Typography>
      <Typography level="body-xs" fontFamily="monospace" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
        {value}
      </Typography>
    </Stack>
  );
}

export function RuntimeInfo() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.b4m.getAppInfo().then(info => {
      if (!cancelled) setAppInfo(info);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!appInfo) {
    return (
      <Typography level="body-xs" textColor="text.tertiary">
        Loading runtime info over IPC...
      </Typography>
    );
  }

  return (
    <Stack spacing={0.5}>
      {/* The app's own version only. The Electron, Node and Chromium versions stay on the
          AppInfo payload - they cost nothing to carry and a diagnostics view would want them -
          but in the account menu they are three lines of noise under the one that is read. */}
      <Row label="App" value={appInfo.appVersion} testId="runtime-info-app-row" />
      {appInfo.versionBasis ? (
        // A sentence, not a value: it gets the full width instead of a wrapped monospace column.
        <Typography
          level="body-xs"
          textColor="text.tertiary"
          sx={{ overflowWrap: 'anywhere' }}
          data-testid="runtime-info-version-basis-row"
        >
          {appInfo.versionBasis}
        </Typography>
      ) : null}
    </Stack>
  );
}
