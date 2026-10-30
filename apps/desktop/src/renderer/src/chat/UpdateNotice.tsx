import IconButton from '@mui/joy/IconButton';
import Link from '@mui/joy/Link';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { updateNoticeVersion, type UpdateState } from '@shared/update';
import { CloseIcon } from './icons';
import { useAppUpdate } from './useAppUpdate';

export interface UpdateNoticeProps {
  state: UpdateState;
  onOpenRelease: (url: string) => void;
  onDismiss: (version: string) => void;
}

/**
 * The small "a newer version exists" card in the window's lower-left corner, sitting in the
 * sidebar just above the account footer. The lower-right holds the composer's send and model
 * controls, which a floating card there would cover.
 *
 * It only informs: the link goes to the release page in the system browser, and downloading or
 * installing stays in Customize (UpdateSettings). Which version it shows, and whether it shows at
 * all, is updateNoticeVersion's call - see @shared/update.
 */
export function UpdateNotice({ state, onOpenRelease, onDismiss }: UpdateNoticeProps) {
  const version = updateNoticeVersion(state);
  if (!version) return null;
  const releaseUrl = state.releaseUrl;

  return (
    <Sheet
      variant="outlined"
      role="status"
      data-testid="update-notice"
      sx={{
        position: 'fixed',
        left: 12,
        bottom: 72,
        zIndex: 'snackbar',
        maxWidth: 256,
        py: 1,
        pl: 1.5,
        pr: 0.5,
        borderRadius: 'md',
        boxShadow: 'md',
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center">
        <Stack spacing={0.25} sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="body-sm" fontWeight="md" data-testid="update-notice-title">
            Bike4Mind {version} is available
          </Typography>
          {releaseUrl && (
            <Link
              level="body-xs"
              component="button"
              onClick={() => onOpenRelease(releaseUrl)}
              sx={{ alignSelf: 'flex-start' }}
              data-testid="update-notice-release-link"
            >
              Release notes and download
            </Link>
          )}
        </Stack>
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
      </Stack>
    </Sheet>
  );
}

/** The notice, kept live from main. Mounted once, in the main window. */
export function AppUpdateNotice() {
  const { state } = useAppUpdate();
  return (
    <UpdateNotice
      state={state}
      onOpenRelease={url => void window.b4m.shell.openExternal(url)}
      onDismiss={version => void window.b4m.update.dismiss(version)}
    />
  );
}
