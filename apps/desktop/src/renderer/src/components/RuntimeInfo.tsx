import { useEffect, useState } from 'react';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { AppInfo } from '@shared/ipc';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <Stack direction="row" justifyContent="space-between" spacing={2}>
      <Typography level="body-sm" textColor="text.tertiary">
        {label}
      </Typography>
      <Typography level="body-sm" fontFamily="monospace">
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
      <Typography level="body-sm" textColor="text.tertiary">
        Loading runtime info over IPC...
      </Typography>
    );
  }

  return (
    <Stack spacing={1}>
      <Row label="App" value={appInfo.appVersion} />
      <Row label="Electron" value={appInfo.electronVersion} />
      <Row label="Node" value={appInfo.nodeVersion} />
      <Row label="Chromium" value={appInfo.chromeVersion} />
    </Stack>
  );
}
