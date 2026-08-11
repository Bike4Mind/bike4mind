import { Box, Button, Chip, CircularProgress, Stack, Tooltip, Typography } from '@mui/joy';
import CloudIcon from '@mui/icons-material/Cloud';
import SyncIcon from '@mui/icons-material/Sync';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import { useState } from 'react';
import { toast } from 'sonner';
import useDrivePicker from 'react-google-drive-picker';
import { api } from '@client/app/contexts/ApiContext';
import { useConfig } from '@client/app/hooks/data/settings';
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

/**
 * Connect a Google Drive FOLDER to an existing data lake. Reuses the same OAuth-token flow the
 * chat attach button uses (redirect to consent when not yet connected, else open the Google Picker),
 * but with folder-select enabled so the picked item is a folder id. Only meaningful against an
 * existing lake - in create mode the lake has no id yet, so the action is disabled with guidance.
 */
export default function DriveConnectAction({ lake }: { lake: { id: string } | null | undefined }) {
  const { data: config } = useConfig();
  const googleClientId = config?.googleClientId;
  const [openPicker] = useDrivePicker();
  const [isPicking, setIsPicking] = useState(false);

  const { data: connection, isLoading } = useLakeDriveConnection(lake?.id);
  const connect = useConnectDriveFolderToLake();
  const disconnect = useDisconnectLakeDrive();

  if (!lake) {
    return (
      <Tooltip title="Save the data lake first, then connect a Google Drive folder to it.">
        <span>
          <Button variant="outlined" color="neutral" startDecorator={<CloudIcon />} disabled>
            Connect Google Drive
          </Button>
        </span>
      </Tooltip>
    );
  }

  const lakeId = lake.id;

  const openFolderPicker = async () => {
    setIsPicking(true);
    try {
      const { data } = await api.get<{ accessToken?: string; authUrl?: string }>('/api/google-drive/token');
      // Not connected yet: hand off to Google's consent screen (full-page, like the attach flow).
      if (data.authUrl) {
        window.location.href = data.authUrl;
        return;
      }
      if (!data.accessToken || !googleClientId) {
        toast.error('Google Drive is unavailable right now. Please try again.');
        return;
      }
      openPicker({
        clientId: googleClientId,
        developerKey: '',
        viewId: 'FOLDERS', // folder-first browse; the user selects a folder to ingest
        viewMimeTypes: '',
        token: data.accessToken,
        showUploadFolders: false,
        supportDrives: true,
        multiselect: false,
        setIncludeFolders: true,
        setSelectFolderEnabled: true, // pick a FOLDER, not a file - its id feeds the ingest
        disableDefaultView: false,
        callbackFunction: pick => {
          if (pick.action !== 'picked') return;
          const folder = pick.docs?.[0];
          if (!folder?.id) return;
          connect.mutate(
            { dataLakeId: lakeId, driveFolderId: folder.id, folderName: folder.name },
            {
              onSuccess: () => toast.success(`Syncing "${folder.name}" into this data lake...`),
              onError: (e: unknown) => {
                const status = (e as { response?: { status?: number } })?.response?.status;
                toast.error(
                  status === 409
                    ? 'That Drive folder is already connected to another data lake.'
                    : 'Could not connect that folder. Please try again.'
                );
              },
            }
          );
        },
      });
    } catch {
      toast.error('Could not open Google Drive. Please try again.');
    } finally {
      setIsPicking(false);
    }
  };

  if (isLoading) {
    return <CircularProgress size="sm" data-testid="drive-connection-loading" />;
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
        <Button
          data-testid="drive-disconnect-btn"
          size="sm"
          variant="plain"
          color="danger"
          startDecorator={<LinkOffIcon />}
          loading={disconnect.isPending}
          onClick={() =>
            disconnect.mutate(lakeId, {
              onSuccess: () => toast.success('Disconnected the Google Drive folder.'),
              onError: () => toast.error('Could not disconnect. Please try again.'),
            })
          }
        >
          Disconnect
        </Button>
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
