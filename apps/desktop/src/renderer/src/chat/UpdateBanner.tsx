import { useState } from 'react';
import Alert from '@mui/joy/Alert';
import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { describeBusy, UNSIGNED_UPDATE_NOTE } from '@shared/update';
import { CloseIcon } from './icons';
import type { AppUpdateController } from './useAppUpdate';

/**
 * The sidebar's "Restart to update", shown once a downloaded update is staged - or, in a build
 * that cannot install updates itself, the installer download for a newer version.
 *
 * Non-blocking on purpose: it sits above the account strip and never takes focus, so a user in
 * the middle of a turn can ignore it until they are done. Dismissing hides it for this version
 * only; the account chip and Settings still say an update is waiting. The busy confirmation is
 * repeated here rather than sent to Settings, because `blockedBy` belongs to this controller and
 * a click should be answered where it was made.
 */
export function UpdateBanner({ controller, onDismiss }: { controller: AppUpdateController; onDismiss: () => void }) {
  const { state, blockedBy, install, dismissBlock, openInstaller } = controller;
  const [notesOpen, setNotesOpen] = useState(false);

  const manual = state.status === 'available' && !state.installable;
  if (state.status !== 'ready' && !manual) return null;

  return (
    <Alert color="primary" variant="soft" size="sm" data-testid="update-banner" sx={{ alignItems: 'flex-start' }}>
      <Stack spacing={1} sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography level="body-sm" sx={{ flex: 1, fontWeight: 'md' }} data-testid="update-banner-title">
            Version {state.version} is {manual ? 'available' : 'ready'}
          </Typography>
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Dismiss update notice"
            onClick={onDismiss}
            data-testid="update-banner-dismiss-btn"
          >
            <CloseIcon />
          </IconButton>
        </Stack>

        {state.notes &&
          (notesOpen ? (
            // Plain text, never markdown or HTML: the notes come off the network.
            <Typography
              level="body-xs"
              data-testid="update-banner-notes"
              sx={{ whiteSpace: 'pre-wrap', maxHeight: 160, overflowY: 'auto', overflowWrap: 'anywhere' }}
            >
              {state.notes}
            </Typography>
          ) : (
            <Button
              size="sm"
              variant="plain"
              color="primary"
              onClick={() => setNotesOpen(true)}
              data-testid="update-banner-notes-btn"
              sx={{ alignSelf: 'flex-start', px: 0.5, minHeight: 0 }}
            >
              What&apos;s new
            </Button>
          ))}

        {manual ? (
          <Stack spacing={1}>
            <Typography level="body-xs" data-testid="update-banner-unsigned">
              {UNSIGNED_UPDATE_NOTE}
            </Typography>
            {state.downloadUrl && (
              <Button
                size="sm"
                variant="solid"
                color="primary"
                onClick={openInstaller}
                data-testid="update-banner-download-btn"
                sx={{ alignSelf: 'flex-start' }}
              >
                Download installer
              </Button>
            )}
          </Stack>
        ) : blockedBy ? (
          <Stack spacing={1} data-testid="update-banner-busy">
            <Typography level="body-xs">{describeBusy(blockedBy)} Restarting stops all of it.</Typography>
            <Stack direction="row" spacing={1}>
              <Button
                size="sm"
                variant="plain"
                color="neutral"
                onClick={dismissBlock}
                data-testid="update-banner-keep-btn"
              >
                Keep working
              </Button>
              <Button
                size="sm"
                variant="solid"
                color="danger"
                onClick={() => void install(true)}
                data-testid="update-banner-force-restart-btn"
              >
                Restart anyway
              </Button>
            </Stack>
          </Stack>
        ) : (
          <Button
            size="sm"
            variant="solid"
            color="primary"
            onClick={() => void install(false)}
            data-testid="update-banner-restart-btn"
            sx={{ alignSelf: 'flex-start' }}
          >
            Restart to update
          </Button>
        )}
      </Stack>
    </Alert>
  );
}
