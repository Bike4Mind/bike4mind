import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import LinearProgress from '@mui/joy/LinearProgress';
import Link from '@mui/joy/Link';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { updateNoticeVersion, type UpdateState } from '@shared/update';
import { CloseIcon } from './icons';
import { UpdateRestartConfirm } from './UpdateSettings';
import type { AppUpdateController } from './useAppUpdate';

/** What the card can do beyond informing. Without it the card only informs. */
export type UpdateNoticeActions = Pick<
  AppUpdateController,
  'blockedBy' | 'downloadFailed' | 'download' | 'install' | 'dismissBlock'
>;

export interface UpdateNoticeProps {
  state: UpdateState;
  onOpenRelease: (url: string) => void;
  onDismiss: (version: string) => void;
  actions?: UpdateNoticeActions;
}

// The bar across the top of the main pane (ChatShell's conversation header, CustomizePanel's): py 1.25
// either side of a size-sm control (2rem) and a 1px divider. A project line under the title adds ~5px.
const HEADER_BAR_HEIGHT = 10 + 32 + 10 + 1;
const EDGE = 12;

function noticeTitle(state: UpdateState, inApp: boolean): string {
  if (inApp && state.status === 'downloading') return 'Downloading update';
  if (inApp && state.status === 'ready') return 'Ready to install';
  return 'Update available';
}

/**
 * The update card, fixed in the window's upper-right corner just below the header bar: clear of
 * the header's controls above it and of the composer at the foot of the window. Given `actions` it
 * downloads and installs; which version it shows, if any, is updateNoticeVersion's call.
 */
export function UpdateNotice({ state, onOpenRelease, onDismiss, actions }: UpdateNoticeProps) {
  // A failed download outranks an earlier dismissal: the user has just asked for this version.
  const version =
    updateNoticeVersion(state) ??
    (actions?.downloadFailed ? updateNoticeVersion({ ...state, dismissedVersion: null }) : null);
  if (!version) return null;
  const releaseUrl = state.releaseUrl;
  const offer = !actions || state.status === 'available';

  return (
    <Sheet
      variant="outlined"
      role="status"
      data-testid="update-notice"
      sx={{
        position: 'fixed',
        top: HEADER_BAR_HEIGHT + EDGE,
        right: EDGE,
        zIndex: 'snackbar',
        width: `min(280px, calc(100vw - ${2 * EDGE}px))`,
        p: 1.5,
        borderRadius: 'md',
        boxShadow: 'md',
      }}
    >
      {/* useFlexGap throughout: a margin-spaced Stack resets its children's own margins. */}
      <Stack spacing={1.25} useFlexGap>
        <Stack spacing={0.25} useFlexGap>
          <Stack direction="row" spacing={1} useFlexGap alignItems="center">
            <Typography level="title-sm" sx={{ flex: 1, minWidth: 0 }} data-testid="update-notice-title">
              {noticeTitle(state, !!actions)}
            </Typography>
            {offer && (
              <IconButton
                size="sm"
                variant="plain"
                color="neutral"
                onClick={() => onDismiss(version)}
                aria-label={`Dismiss the notice for Bike4Mind ${version}`}
                // Puts the glyph, not the 2rem hit area, on the card's padding line and the title's.
                sx={{ m: -1 }}
                data-testid="update-notice-dismiss-btn"
              >
                <CloseIcon />
              </IconButton>
            )}
          </Stack>
          <Typography level="body-xs" sx={{ overflowWrap: 'anywhere' }} data-testid="update-notice-version-text">
            Bike4Mind {version}
          </Typography>
          {offer && releaseUrl && (
            <Link
              level="body-xs"
              component="button"
              onClick={() => onOpenRelease(releaseUrl)}
              sx={{ alignSelf: 'flex-start' }}
              data-testid="update-notice-release-link"
            >
              {actions ? 'Release notes' : 'Release notes and download'}
            </Link>
          )}
        </Stack>

        {actions && <NoticeActions state={state} actions={actions} />}
      </Stack>
    </Sheet>
  );
}

function NoticeActions({ state, actions }: { state: UpdateState; actions: UpdateNoticeActions }) {
  if (state.status === 'downloading') {
    return (
      <Stack direction="row" spacing={1} useFlexGap alignItems="center">
        <LinearProgress
          determinate
          value={state.percent}
          size="sm"
          sx={{ flex: 1 }}
          aria-label="Update download progress"
          data-testid="update-notice-progress"
        />
        {/* Kept out of the live region, which would read out every percent; the bar carries it. */}
        <Typography level="body-xs" aria-hidden data-testid="update-notice-percent-text">
          {state.percent}%
        </Typography>
      </Stack>
    );
  }

  if (state.status === 'ready') {
    if (actions.blockedBy) {
      return (
        <Stack spacing={1} useFlexGap>
          <UpdateRestartConfirm
            busy={actions.blockedBy}
            onKeep={actions.dismissBlock}
            onRestart={() => void actions.install(true)}
          />
        </Stack>
      );
    }
    return (
      <Button
        size="sm"
        onClick={() => void actions.install(false)}
        sx={{ alignSelf: 'flex-end' }}
        data-testid="update-notice-install-btn"
      >
        Restart to update
      </Button>
    );
  }

  return (
    <>
      {actions.downloadFailed && (
        <Typography level="body-xs" color="danger" data-testid="update-notice-error-text">
          The download did not finish.
        </Typography>
      )}
      <Button
        size="sm"
        onClick={actions.download}
        sx={{ alignSelf: 'flex-end' }}
        data-testid="update-notice-download-btn"
      >
        {actions.downloadFailed ? 'Try again' : 'Update'}
      </Button>
    </>
  );
}

/** The notice wired to main through `controller`, which the account label shares. */
export function AppUpdateNotice({ controller }: { controller: AppUpdateController }) {
  return (
    <UpdateNotice
      state={controller.state}
      actions={controller}
      onOpenRelease={url => void window.b4m.shell.openExternal(url)}
      onDismiss={controller.dismiss}
    />
  );
}
