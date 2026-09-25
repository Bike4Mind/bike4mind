import { useEffect, useState } from 'react';
import Box from '@mui/joy/Box';
import Card from '@mui/joy/Card';
import Chip from '@mui/joy/Chip';
import Divider from '@mui/joy/Divider';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { chatContract } from '@bike4mind/common';
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

export function Placeholder() {
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

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        bgcolor: 'background.body',
        p: 3,
      }}
    >
      <Card variant="outlined" sx={{ width: 'min(520px, 100%)', gap: 2 }}>
        <Stack spacing={0.5}>
          <Typography level="h2">Bike4Mind Desktop</Typography>
          <Typography level="body-md" textColor="text.secondary">
            Scaffold only. Sign-in and chat arrive in later tasks.
          </Typography>
        </Stack>

        <Divider />

        <Stack spacing={1}>
          {appInfo ? (
            <>
              <Row label="App" value={appInfo.appVersion} />
              <Row label="Electron" value={appInfo.electronVersion} />
              <Row label="Node" value={appInfo.nodeVersion} />
              <Row label="Chromium" value={appInfo.chromeVersion} />
            </>
          ) : (
            <Typography level="body-sm" textColor="text.tertiary">
              Loading runtime info over IPC...
            </Typography>
          )}
        </Stack>

        <Divider />

        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Chip size="sm" variant="soft" color="success">
            @bike4mind/common loaded
          </Chip>
          <Typography level="body-xs" fontFamily="monospace" textColor="text.tertiary">
            {chatContract.method.toUpperCase()} {chatContract.path}
          </Typography>
        </Stack>
      </Card>
    </Box>
  );
}
