import Alert from '@mui/joy/Alert';
import Button from '@mui/joy/Button';
import DialogTitle from '@mui/joy/DialogTitle';
import Divider from '@mui/joy/Divider';
import LinearProgress from '@mui/joy/LinearProgress';
import Modal from '@mui/joy/Modal';
import ModalClose from '@mui/joy/ModalClose';
import ModalDialog from '@mui/joy/ModalDialog';
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
 * A dialog rather than an in-place row like Appearance, because this is the one Customize entry
 * with real actions behind it - downloading megabytes and restarting the app are not things to
 * put one click from a list.
 *
 * Nothing here ever reports a failed check as an error. An unreachable feed renders as the
 * plain version with a "Check again" button, which is both honest and the only thing the user
 * could do about it anyway.
 */
export function UpdateDialog({
  open,
  onClose,
  controller,
}: {
  open: boolean;
  onClose: () => void;
  controller: AppUpdateController;
}) {
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
    <Modal open={open} onClose={onClose}>
      <ModalDialog sx={{ width: 420, maxWidth: '92vw' }} data-testid="update-dialog">
        <ModalClose />
        <DialogTitle>Updates</DialogTitle>

        <Stack spacing={1.5}>
          <Stack spacing={0.25}>
            <Typography level="body-sm" sx={{ fontWeight: 'md' }} data-testid="update-current-version">
              Version {state.currentVersion}
            </Typography>
            {state.status !== 'unsupported' && (
              <Typography level="body-xs" textColor="text.tertiary">
                {lastChecked(state.checkedAt)}
              </Typography>
            )}
          </Stack>

          <Divider />

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
      </ModalDialog>
    </Modal>
  );
}
