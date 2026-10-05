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
} from '@client/app/hooks/data/googleDrive';
import { describeDriveConnection } from '@client/app/hooks/data/driveConnectionDisplay';
import { useDriveFolderPicker } from '@client/app/hooks/data/useDriveFolderPicker';
import { getServerErrorField } from '@client/app/utils/error';
import DriveAccessDisclosure from './DriveAccessDisclosure';

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
          onError: (e: unknown) =>
            toast.error(getServerErrorField(e) || 'Could not connect that folder. Please try again.'),
        }
      ),
  });

  if (isLoading) {
    return <CircularProgress size="sm" data-testid="drive-connection-loading" />;
  }

  if (isError) {
    // Every caller gates this component on org scope already (see SourceSelectionStep and
    // SelectedLakeHeader), but the read itself needs org owner/manager - narrower than
    // canManageLake, which also grants the lake's creator, a curator grant, or an administered
    // org. So this is a normal, steady state for an org member who can manage the lake without
    // being its org's owner or manager, not just a render/fetch race. No working connect action
    // to offer either way, so disable it with guidance rather than render a button that can only fail.
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
    // Not DRIVE_STATUS_BADGE directly: a 'connected' connection carrying a lastError is a sync that
    // stopped short with files missing, and only describeDriveConnection reads it that way.
    const { label, color } = describeDriveConnection(connection);
    return (
      <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap" data-testid="drive-connection-status">
        <CloudIcon color="primary" />
        <Typography level="body-sm">
          <strong>{connection.folderName || connection.driveFolderId}</strong>
        </Typography>
        <Chip size="sm" variant="soft" color={color}>
          {label}
        </Chip>
        {/* drive-sync refuses a folder whose disconnect purge is still queued. */}
        {!connection.disconnecting && (
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
        )}
        {connection.disconnecting && (
          <Typography level="body-xs" data-testid="drive-disconnecting-note" sx={{ flexBasis: '100%' }}>
            {connection.fileCount === 0
              ? 'Finishing disconnect...'
              : `Removing ${connection.fileCount} remaining file${connection.fileCount === 1 ? '' : 's'} in the background.`}
          </Typography>
        )}
        {confirmingDisconnect ? (
          <>
            <Typography
              level="body-xs"
              color="danger"
              data-testid="drive-disconnect-warning"
              sx={{ flexBasis: '100%' }}
            >
              This will permanently delete {connection.fileCount} file{connection.fileCount === 1 ? '' : 's'} this
              connection ingested into the data lake.
            </Typography>
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
                    toast.success(
                      'Disconnecting the Google Drive folder. Its files are being removed in the background.'
                    );
                  },
                  // Surface e.g. the 409 "a sync is in progress" so the user knows to retry later.
                  onError: (e: unknown) =>
                    toast.error(getServerErrorField(e) || 'Could not disconnect. Please try again.'),
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
            // The route declines to re-queue a purge that is still progressing, so only offer a retry
            // once it looks stalled.
            disabled={connection.disconnecting && !connection.disconnectStalled}
            onClick={() => setConfirmingDisconnect(true)}
          >
            {!connection.disconnecting
              ? 'Disconnect'
              : connection.disconnectStalled
                ? 'Retry disconnect'
                : 'Disconnecting'}
          </Button>
        )}
        {connection.lastError && (
          <Box sx={{ flexBasis: '100%' }}>
            {/* Shown for ANY status that recorded one, not just credential_error: a sync that stopped
                short heals the status back to 'connected', so gating on the error statuses hid the
                one message saying files are missing from the lake (#2394). */}
            <Typography level="body-xs" color={color} data-testid="drive-connection-last-error">
              {connection.lastError}
            </Typography>
          </Box>
        )}
      </Stack>
    );
  }

  return (
    <Stack gap={0.5}>
      <Button
        data-testid="drive-connect-btn"
        variant="outlined"
        color="neutral"
        startDecorator={<CloudIcon />}
        loading={isPicking || connect.isPending}
        onClick={openFolderPicker}
        sx={{ alignSelf: 'flex-start' }}
      >
        Connect Google Drive
      </Button>
      <DriveAccessDisclosure />
    </Stack>
  );
}
