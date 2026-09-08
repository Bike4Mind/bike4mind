import { Box, Button, Chip, CircularProgress, Stack, Tooltip, Typography } from '@mui/joy';
import CloudIcon from '@mui/icons-material/Cloud';
import SyncIcon from '@mui/icons-material/Sync';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  useLakeDriveConnection,
  useConnectDriveFolderToLake,
  useDisconnectLakeDrive,
  DRIVE_STATUS_BADGE,
} from '@client/app/hooks/data/googleDrive';
import { useDriveFolderPicker } from '@client/app/hooks/data/useDriveFolderPicker';

/** The specific server `error` message off an axios failure, if the response carried one. */
function serverError(e: unknown): string | undefined {
  return (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
}

/**
 * Connect a Google Drive FOLDER to an EXISTING data lake: pick a folder and the connection is
 * created straight away, since the lake already has an id to bind to. Create mode has no id yet
 * and so uses DrivePendingConnectAction, which parks the selection until commit (#1916).
 */
export default function DriveConnectAction({ lake }: { lake: { id: string } }) {
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const { data: connection, isLoading, isError } = useLakeDriveConnection(lake.id);
  const connect = useConnectDriveFolderToLake();
  const disconnect = useDisconnectLakeDrive();

  const lakeId = lake.id;

  const { openFolderPicker, isPicking } = useDriveFolderPicker({
    busy: connect.isPending,
    onPicked: folder =>
      connect.mutate(
        { dataLakeId: lakeId, ...folder },
        {
          onSuccess: () =>
            toast.success(`Syncing "${folder.folderName || folder.driveFolderId}" into this data lake...`),
          // Surface the server's specific message (folder claimed elsewhere, lake already bound to a
          // different folder, "connect Drive first", ...) rather than one generic string for every 409.
          onError: (e: unknown) => toast.error(serverError(e) || 'Could not connect that folder. Please try again.'),
        }
      ),
  });

  if (isLoading) {
    return <CircularProgress size="sm" data-testid="drive-connection-loading" />;
  }

  if (isError) {
    // The status query 404s for a personal lake and 403s for a non-manager - either way there is no
    // working connect action to offer, so disable it with guidance rather than render an enabled
    // button that can only ever fail.
    return (
      <Tooltip title="Google Drive connect is available to organization owners/managers on an organization data lake.">
        <span>
          <Button
            data-testid="drive-connect-unavailable-btn"
            variant="outlined"
            color="neutral"
            startDecorator={<CloudIcon />}
            disabled
          >
            Connect Google Drive
          </Button>
        </span>
      </Tooltip>
    );
  }

  if (connection) {
    const badge = DRIVE_STATUS_BADGE[connection.status];
    return (
      <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap" data-testid="drive-connection-status">
        <CloudIcon color="primary" />
        <Typography level="body-sm">
          <strong>{connection.folderName || connection.driveFolderId}</strong>
        </Typography>
        <Chip size="sm" variant="soft" color={badge.color}>
          {badge.label}
        </Chip>
        <Button
          data-testid="drive-resync-btn"
          size="sm"
          variant="outlined"
          color="neutral"
          startDecorator={<SyncIcon />}
          loading={connect.isPending || isPicking}
          onClick={openFolderPicker}
        >
          Re-sync
        </Button>
        {confirmingDisconnect ? (
          <>
            <Button
              data-testid="drive-disconnect-confirm-btn"
              size="sm"
              variant="soft"
              color="danger"
              startDecorator={<LinkOffIcon />}
              loading={disconnect.isPending}
              onClick={() =>
                disconnect.mutate(lakeId, {
                  onSuccess: () => {
                    setConfirmingDisconnect(false);
                    toast.success('Disconnected the Google Drive folder.');
                  },
                  // Surface e.g. the 409 "a sync is in progress" so the user knows to retry later.
                  onError: (e: unknown) => toast.error(serverError(e) || 'Could not disconnect. Please try again.'),
                })
              }
            >
              Confirm disconnect
            </Button>
            <Button
              data-testid="drive-disconnect-cancel-btn"
              size="sm"
              variant="plain"
              color="neutral"
              disabled={disconnect.isPending}
              onClick={() => setConfirmingDisconnect(false)}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            data-testid="drive-disconnect-btn"
            size="sm"
            variant="plain"
            color="danger"
            startDecorator={<LinkOffIcon />}
            onClick={() => setConfirmingDisconnect(true)}
          >
            Disconnect
          </Button>
        )}
        {connection.status === 'credential_error' && connection.lastError && (
          <Box sx={{ flexBasis: '100%' }}>
            <Typography level="body-xs" color="danger">
              {connection.lastError}
            </Typography>
          </Box>
        )}
      </Stack>
    );
  }

  return (
    <Button
      data-testid="drive-connect-btn"
      variant="outlined"
      color="neutral"
      startDecorator={<CloudIcon />}
      loading={isPicking || connect.isPending}
      onClick={openFolderPicker}
    >
      Connect Google Drive
    </Button>
  );
}
