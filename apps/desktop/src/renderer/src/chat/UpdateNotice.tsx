import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import LinearProgress from '@mui/joy/LinearProgress';
import Link from '@mui/joy/Link';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { SxProps } from '@mui/joy/styles/types';
import { updateNoticeVersion, type UpdateState } from '@shared/update';
import { CloseIcon } from './icons';
import { UpdateRestartConfirm } from './UpdateSettings';
import { useAppUpdate, type AppUpdateController } from './useAppUpdate';

/** What the card can do beyond informing. Without it the card only informs. */
export type UpdateNoticeActions = Pick<
  AppUpdateController,
  'blockedBy' | 'downloadFailed' | 'download' | 'install' | 'dismissBlock'
>;

/** In the flow of the sidebar's account footer, or floating where that footer is not drawn. */
export type UpdateNoticePlacement = 'sidebar' | 'floating';

export interface UpdateNoticeProps {
  state: UpdateState;
  onOpenRelease: (url: string) => void;
  onDismiss: (version: string) => void;
  actions?: UpdateNoticeActions;
  placement?: UpdateNoticePlacement;
}

const PLACEMENT_SX = {
  // In the footer's own flow, so the account menu opening below it pushes it up, never under it.
  sidebar: {},
  floating: { position: 'fixed', left: 12, bottom: 72, zIndex: 'snackbar', maxWidth: 256, boxShadow: 'md' },
} satisfies Record<UpdateNoticePlacement, SxProps>;

function noticeTitle(state: UpdateState, version: string, inApp: boolean): string {
  if (inApp && state.status === 'downloading') return `Downloading Bike4Mind ${version}...`;
  if (inApp && state.status === 'ready') return `Bike4Mind ${version} is ready to install`;
  return `Bike4Mind ${version} is available`;
}

/**
 * The small "a newer version exists" card in the window's lower-left corner: at the top of the
 * sidebar's account footer, or floating there when that footer is not drawn (the sign-in screen,
 * a collapsed sidebar). The lower-right holds the composer's send and model controls, which a
 * card there would cover.
 *
 * Given `actions` it carries the update through: Update downloads, the card follows the progress,
 * and Restart to update installs, asking first when work would be interrupted. Without them it only
 * informs and links to the release page. Which version it shows, and whether it shows at all, is
 * updateNoticeVersion's call - see @shared/update.
 */
export function UpdateNotice({ state, onOpenRelease, onDismiss, actions, placement = 'floating' }: UpdateNoticeProps) {
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
      sx={{ py: 1, pl: 1.5, pr: 0.5, borderRadius: 'md', ...PLACEMENT_SX[placement] }}
    >
      <Stack spacing={0.75}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Stack spacing={0.25} sx={{ flex: 1, minWidth: 0 }}>
            <Typography level="body-sm" fontWeight="md" data-testid="update-notice-title">
              {noticeTitle(state, version, !!actions)}
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
          {offer && (
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              onClick={() => onDismiss(version)}
              aria-label={`Dismiss the notice for Bike4Mind ${version}`}
              data-testid="update-notice-dismiss-btn"
            >
              <CloseIcon />
            </IconButton>
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
      <Stack direction="row" spacing={1} alignItems="center" sx={{ pr: 1 }}>
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
        <Stack spacing={1} sx={{ pr: 1 }}>
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
        sx={{ alignSelf: 'flex-end', mr: 1 }}
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
        sx={{ alignSelf: 'flex-end', mr: 1 }}
        data-testid="update-notice-download-btn"
      >
        {actions.downloadFailed ? 'Try again' : 'Update'}
      </Button>
    </>
  );
}

/** The notice driving `controller`, for a place that shares it with another update control. */
export function ControlledUpdateNotice({
  controller,
  placement,
}: {
  controller: AppUpdateController;
  placement?: UpdateNoticePlacement;
}) {
  return (
    <UpdateNotice
      state={controller.state}
      actions={controller}
      placement={placement}
      onOpenRelease={url => void window.b4m.shell.openExternal(url)}
      onDismiss={controller.dismiss}
    />
  );
}

/** The notice on its own subscription to main. */
export function AppUpdateNotice({ placement }: { placement?: UpdateNoticePlacement }) {
  return <ControlledUpdateNotice controller={useAppUpdate()} placement={placement} />;
}
