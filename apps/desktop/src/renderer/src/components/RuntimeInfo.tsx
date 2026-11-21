import { useEffect, useState } from 'react';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import type { AppInfo } from '@shared/ipc';

type CopyState = 'idle' | 'copied' | 'failed';

/** How long the copy outcome replaces the value in the tooltip, in ms. */
const FEEDBACK_MS = 1500;

/**
 * One label/value line. Dev and canary versions are long unbroken tokens, so the value
 * truncates to the menu's width; the full string is one hover away and a click copies it,
 * the same pattern as ProjectSubtitleLine.
 */
function Row({ label, value, testId }: { label: string; value: string; testId: string }) {
  const [copy, setCopy] = useState<CopyState>('idle');

  useEffect(() => {
    if (copy === 'idle') return;
    const timer = window.setTimeout(() => setCopy('idle'), FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copy]);

  const copyValue = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopy('copied');
    } catch (error) {
      console.error(`Copying the ${label} value to the clipboard failed`, error);
      setCopy('failed');
    }
  };

  const tip = copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Could not copy' : value;

  return (
    <Stack direction="row" justifyContent="space-between" spacing={2} sx={{ minWidth: 0 }} data-testid={testId}>
      <Typography level="body-sm" textColor="text.tertiary" sx={{ flexShrink: 0 }}>
        {label}
      </Typography>
      <Tooltip title={tip} size="sm" variant="soft" placement="top-end">
        <Typography
          component="button"
          type="button"
          level="body-sm"
          fontFamily="monospace"
          noWrap
          onClick={() => void copyValue()}
          aria-label={`${label} ${value}. Copy`}
          data-copy-state={copy}
          data-testid={`${testId}-value`}
          sx={{
            minWidth: 0,
            p: 0,
            border: 0,
            background: 'none',
            color: 'inherit',
            textAlign: 'right',
            cursor: 'copy',
          }}
        >
          {value}
        </Typography>
      </Tooltip>
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
    <Stack spacing={1} sx={{ minWidth: 0 }}>
      {/* The app's own version only. The Electron, Node and Chromium versions stay on the
          AppInfo payload - they cost nothing to carry and a diagnostics view would want them -
          but in the account menu they are three lines of noise under the one that is read. */}
      <Row label="App" value={appInfo.appVersion} testId="runtime-info-app-row" />
      {appInfo.versionBasis ? (
        <Row label="Version basis" value={appInfo.versionBasis} testId="runtime-info-version-basis-row" />
      ) : null}
    </Stack>
  );
}
