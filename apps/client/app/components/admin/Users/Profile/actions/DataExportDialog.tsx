import React from 'react';
import { Button, CircularProgress, Stack, Typography } from '@mui/joy';
import { toast } from 'sonner';
import type { AdminDataExportStatus, AdminDataExportSummary } from '@bike4mind/common';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import { ActionDialog, ADMIN_REASON_PRESETS, StatusChip, formatUtc } from '../../../shared';
import { displayName } from '../userProfileModel';
import type { ProfileDialogProps } from './profileActions';
import { useAdminDataExports, useDownloadAdminDataExport, useRequestAdminDataExport } from './useAdminDataExports';

const STATUS_CHIP: Readonly<Record<AdminDataExportStatus['state'], { tone: AdminStatusTone; label: string }>> = {
  building: { tone: 'info', label: 'Building' },
  ready: { tone: 'good', label: 'Ready' },
  expired: { tone: 'neutral', label: 'Expired' },
  failed: { tone: 'bad', label: 'Not built' },
};

const ExportRow: React.FC<{
  entry: AdminDataExportSummary;
  downloading: boolean;
  onDownload: (exportJobId: string) => void;
}> = ({ entry, downloading, onDownload }) => {
  const chip = STATUS_CHIP[entry.status.state];
  return (
    <Stack direction="row" alignItems="center" spacing={1.5} data-testid="data-export-row">
      <Stack sx={{ flex: 1, minWidth: 0 }}>
        <Typography level="body-sm">
          {formatUtc(new Date(entry.requestedAt))} by {entry.requestedBy}
        </Typography>
        {entry.status.state === 'ready' && (
          <Typography level="body-xs">Available until {formatUtc(new Date(entry.status.expiresAt))}</Typography>
        )}
        {entry.status.state === 'failed' && (
          <Typography level="body-xs">The export did not finish. Request a new one.</Typography>
        )}
      </Stack>
      <StatusChip tone={chip.tone} label={chip.label} data-testid="data-export-status-chip" />
      {entry.status.state === 'ready' && (
        <Button
          size="sm"
          variant="outlined"
          loading={downloading}
          onClick={() => onDownload(entry.exportJobId)}
          data-testid="data-export-download-btn"
        >
          Download
        </Button>
      )}
    </Stack>
  );
};

/**
 * Data subject access/portability request: queues a zip of everything stored about this person and
 * lists the recent ones to download. Requesting and downloading are each audited on the server.
 */
export const DataExportDialog: React.FC<ProfileDialogProps> = ({ user, onClose }) => {
  const exports = useAdminDataExports(user.id);
  const request = useRequestAdminDataExport(user.id);
  const download = useDownloadAdminDataExport(user.id);

  const handleConfirm = async (reason: string) => {
    await request.mutateAsync(reason);
    toast.success('Export requested. It is listed here once it is built, usually within 15 minutes.');
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title={`Export data of ${displayName(user)}`}
      description="Builds a zip of everything stored about this person: their profile, notebooks, files, memories and every database record that names them, with credentials and secrets removed. The download link works for 24 hours. The person is not notified."
      reasonPresets={ADMIN_REASON_PRESETS.dataSubjectExport}
      confirmLabel="Request export"
      pending={request.isPending}
      onConfirm={handleConfirm}
      data-testid="data-export-dialog"
    >
      <Stack spacing={1} data-testid="data-export-list">
        <Typography level="title-sm">Recent exports</Typography>
        {exports.isPending && <CircularProgress size="sm" />}
        {exports.isError && (
          <Typography level="body-sm" color="danger">
            Could not load the recent exports.
          </Typography>
        )}
        {exports.data?.length === 0 && <Typography level="body-sm">No exports in the last day.</Typography>}
        {exports.data?.map(entry => (
          <ExportRow
            key={entry.exportJobId}
            entry={entry}
            downloading={download.isPending && download.variables === entry.exportJobId}
            onDownload={download.mutate}
          />
        ))}
      </Stack>
    </ActionDialog>
  );
};
