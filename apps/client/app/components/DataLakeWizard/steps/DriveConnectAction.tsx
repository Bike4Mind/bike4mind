import { Box, Button, Chip, CircularProgress, Stack, Tooltip, Typography } from '@mui/joy';
import CloudIcon from '@mui/icons-material/Cloud';
import SyncIcon from '@mui/icons-material/Sync';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import { useState } from 'react';
import { toast } from 'sonner';
import useDrivePicker from 'react-google-drive-picker';
import { api } from '@client/app/contexts/ApiContext';
import { useConfig } from '@client/app/hooks/data/settings';
import { ensureGoogleDrivePickerStyles } from '@client/app/utils/googleDrivePickerStyles';
import {
  useLakeDriveConnection,
  useConnectDriveFolderToLake,
  useDisconnectLakeDrive,
  type LakeDriveConnection,
} from '@client/app/hooks/data/googleDrive';

const STATUS_LABEL: Record<LakeDriveConnection['status'], { label: string; color: 'success' | 'warning' | 'danger' }> =
  {
    connected: { label: 'Connected', color: 'success' },
    needs_reconnect: { label: 'Needs reconnect', color: 'warning' },
    credential_error: { label: 'Credential error', color: 'danger' },
  };

/** The specific server `error` message off an axios failure, if the response carried one. */
function serverError(e: unknown): string | undefined {
  return (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
}
function httpStatus(e: unknown): number | undefined {
  return (e as { response?: { status?: number } })?.response?.status;
}

/**
 * Connect a Google Drive FOLDER to an existing data lake. Reuses the same OAuth-token flow the chat
 * attach button uses (redirect to consent when not yet connected, else open the Google Picker), but
 * with folder-select enabled so the picked item is a folder id. Only meaningful against an existing
 * lake - in create mode the lake has no id yet, so the action is disabled with guidance.
 */
export default function DriveConnectAction({ lake }: { lake: { id: string } | null | undefined }) {
  const { data: config } = useConfig();
  const googleClientId = config?.googleClientId;
  const [openPicker] = useDrivePicker();
  const [isPicking, setIsPicking] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const { data: connection, isLoading, isError } = useLakeDriveConnection(lake?.id);
  const connect = useConnectDriveFolderToLake();
  const disconnect = useDisconnectLakeDrive();

  if (!lake) {
    return (
      <Tooltip title="Save the data lake first, then connect a Google Drive folder to it.">
        <span>
          <Button
            data-testid="drive-connect-disabled-btn"
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

  const lakeId = lake.id;

  const openFolderPicker = async () => {
    if (isPicking || connect.isPending) return; // re-entrancy guard: never open a second picker
    setIsPicking(true);
    try {
      let token: { accessToken?: string; authUrl?: string };
      try {
        const { data } = await api.get<{ accessToken?: string; authUrl?: string }>('/api/google-drive/token');
        token = data;
      } catch (e) {
        // First-time user: /token 400s ("Google Drive not connected") when Drive was never linked.
        // Send them to Google's consent screen (the same POST /connect the profile flow uses); they
        // come back and can then pick a folder. Any other error falls through to the outer catch.
        if (httpStatus(e) === 400) {
          const { data } = await api.post<{ authUrl: string }>('/api/google-drive/connect');
          window.location.href = data.authUrl;
          return;
        }
        throw e;
      }

      // Not connected / refresh failed: /token hands back an authUrl instead of a token.
      if (token.authUrl) {
        window.location.href = token.authUrl;
        return;
      }
      if (!token.accessToken || !googleClientId) {
        toast.error('Google Drive is unavailable right now. Please try again.');
        setIsPicking(false);
        return;
      }

      ensureGoogleDrivePickerStyles(); // keep the picker above the wizard modal (z-index 1400)
      openPicker({
        clientId: googleClientId,
        developerKey: '',
        viewId: 'FOLDERS', // folder-first browse; the user selects a folder to ingest
        viewMimeTypes: '',
        token: token.accessToken,
        showUploadFolders: false,
        supportDrives: true,
        multiselect: false,
        setIncludeFolders: true,
        setSelectFolderEnabled: true, // pick a FOLDER, not a file - its id feeds the ingest
        disableDefaultView: false,
        callbackFunction: pick => {
          // Clear the button's loading state as the picker closes. openPicker() is synchronous, so
          // this must happen in the callback, not right after the call - otherwise the button drops
          // its loading state while the picker is still open and a second click opens a second picker.
          if (pick.action === 'picked' || pick.action === 'cancel') setIsPicking(false);
          if (pick.action !== 'picked') return;
          const folder = pick.docs?.[0];
          if (!folder?.id) return;
          connect.mutate(
            { dataLakeId: lakeId, driveFolderId: folder.id, folderName: folder.name },
            {
              onSuccess: () => toast.success(`Syncing "${folder.name}" into this data lake...`),
              // Surface the server's specific message (folder claimed elsewhere, lake already bound to a
              // different folder, "connect Drive first", ...) rather than one generic string for every 409.
              onError: (e: unknown) =>
                toast.error(serverError(e) || 'Could not connect that folder. Please try again.'),
            }
          );
        },
      });
    } catch {
      toast.error('Could not open Google Drive. Please try again.');
      setIsPicking(false);
    }
  };

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
    const badge = STATUS_LABEL[connection.status];
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
