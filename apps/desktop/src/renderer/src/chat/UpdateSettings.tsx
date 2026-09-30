import Alert from '@mui/joy/Alert';
import Button from '@mui/joy/Button';
import LinearProgress from '@mui/joy/LinearProgress';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { describeBusy } from '@shared/update';
import type { AppUpdateController } from './useAppUpdate';

function lastChecked(at: number | null): string {
  if (at === null) return 'Not checked yet';
  return `Last checked ${new Date(at).toLocaleString()}`;
}

/**
 * The version, and whatever can be done about it.
 *
 * A section of the Customize screen rather than a window of its own. It was a dialog because
 * downloading megabytes and restarting the app are not things to put one click from a list -
 * a screen keeps that, because the actions still sit under the version, the last check and,
 * when there is one, the warning naming what a restart would end. Nothing has moved closer to
 * a stray click; the window around it was all that went.
 *
 * Nothing here ever reports a failed check as an error. An unreachable feed renders as the
 * plain version with a "Check again" button, which is both honest and the only thing the user
 * could do about it anyway.
 */
export function UpdateSettings({ controller }: { controller: AppUpdateController }) {
  const { state, blockedBy, check, download, install, dismissBlock } = controller;

  const body = (() => {
    switch (state.status) {
      case 'unsupported':
        // Honest about why rather than silent: a dev run and a fork both land here, and a row
        // that simply never finds an update is more confusing than one that says it will not look.
        return <Typography level="body-sm">This build does not check for updates.</Typography>;
      case 'checking':
        return <Typography level="body-sm">Checking for updates...</Typography>;
      case 'available':
        return <Typography level="body-sm">Version {state.version} is available.</Typography>;
      case 'downloading':
        return (
          <Stack spacing={1}>
            <Typography level="body-sm">Downloading version {state.version}...</Typography>
            <LinearProgress determinate value={state.percent} />
          </Stack>
        );
      case 'ready':
        return (
          <Typography level="body-sm">
            Version {state.version} is downloaded. It runs after the app restarts.
          </Typography>
        );
      case 'up-to-date':
        return <Typography level="body-sm">This is the newest version.</Typography>;
      default:
        return <Typography level="body-sm">No update has been found yet.</Typography>;
    }
  })();

  const busy = state.status === 'checking' || state.status === 'downloading';

  return (
    <Stack spacing={1.5} data-testid="update-settings">
      {/* The version is the section's own summary line, so only what that line cannot say is
          repeated here. */}
      {state.status !== 'unsupported' && (
        <Typography level="body-xs" textColor="text.tertiary" data-testid="update-last-checked">
          {lastChecked(state.checkedAt)}
        </Typography>
      )}

      <div data-testid="update-body">{body}</div>

      {blockedBy && (
        <Alert color="warning" variant="soft" data-testid="update-busy-alert">
          <Stack spacing={0.5}>
            <Typography level="body-sm" sx={{ fontWeight: 'md' }}>
              {describeBusy(blockedBy)}
            </Typography>
            <Typography level="body-xs">
              Restarting stops all of it. Anything a session has not finished writing is lost.
            </Typography>
          </Stack>
        </Alert>
      )}

      <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
        {state.status !== 'unsupported' && !blockedBy && (
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            loading={state.status === 'checking'}
            disabled={busy}
            onClick={check}
            data-testid="update-check-btn"
          >
            Check again
          </Button>
        )}

        {state.status === 'available' && (
          <Button size="sm" variant="solid" onClick={download} data-testid="update-download-btn">
            Download
          </Button>
        )}

        {state.status === 'ready' && !blockedBy && (
          <Button size="sm" variant="solid" onClick={() => void install(false)} data-testid="update-install-btn">
            Restart and install
          </Button>
        )}

        {blockedBy && (
          <>
            <Button size="sm" variant="plain" color="neutral" onClick={dismissBlock} data-testid="update-keep-btn">
              Keep working
            </Button>
            {/* The user has now been told exactly what this ends, so it says so. */}
            <Button
              size="sm"
              variant="solid"
              color="danger"
              onClick={() => void install(true)}
              data-testid="update-force-install-btn"
            >
              Restart anyway
            </Button>
          </>
        )}
      </Stack>
    </Stack>
  );
}
